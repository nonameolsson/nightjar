import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pull } from './code-host.js';
import { FakeCodeHost } from './fakes/code-host.js';
import { record } from './ledger.js';
import { fileLogbook } from './logbook.js';
import { measuresPath, PULL_STATES_EVERY_MS, refreshPullStates } from './measures-cache.js';
import { readFactory } from './status-reader.js';
import { renderPanels, startUi, type Ui } from './ui.js';
import { NO_LINKS } from './ui-links.js';
import { measuresView, NO_PULL_STATE, watchMeasures, type CodeHostKnown } from './ui-measures.js';

let root: string;
let ui: Ui | null;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-measures-'));
	ui = null;
});
afterEach(async () => {
	await ui?.close();
	rmSync(root, { recursive: true, force: true });
});

// the moment the pull requests open, and the moment the Measures are read
const at = new Date(2026, 9, 30, 9, 0);
const started = new Date(2026, 9, 30, 8, 30).toISOString();
const ledgerFile = () => join(root, '.factory', 'runs.jsonl');

const NIGHTJAR = 'Build #1 A\n\nFactory-Ticket: #1';

// a Code host that was opened and has pullState
const NO_HOST_YET = { reader: 'has', fault: null } as const;

// Two pull requests Nightjar opened: the first with commits that are all its own, the second with a commit a person made.
async function opened(host: FakeCodeHost): Promise<{ one: Pull; two: Pull }> {
	const open = async (branch: string, feature: string, commits: readonly string[]) => {
		const pull = await host.createDraft({ title: branch, head: branch, base: 'main', body: 'b' });
		for (const message of commits) host.branchMovedByPerson(branch, message);
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/app',
			feature,
			ticket: feature,
			branch,
			step: 'build',
			session: `s-${feature}`,
			costUsd: 1.5,
			outcome: 'built'
		});
		const book = fileLogbook(root);
		book.write({ at: started, feature, kind: 'buildStarted', by: 'go', branch, workflow: null });
		book.write({ at: at.toISOString(), feature, kind: 'pullOpened', url: pull.url, created: true });
		return pull;
	};
	return {
		one: await open('factory/1-a', '1', [NIGHTJAR]),
		two: await open('factory/2-b', '2', [NIGHTJAR, 'Fix a typo'])
	};
}

describe('watchMeasures', () => {
	it('asks the Code host at most once an hour, however often it looks, and never again about a merged pull request', async () => {
		const host = new FakeCodeHost();
		const { one, two } = await opened(host);
		host.merge(one);
		let clock = at.getTime();
		const ticks: (() => void)[] = [];
		const watch = watchMeasures({
			root,
			codeHost: () => Promise.resolve(host),
			changed: () => {},
			every: (_ms, tick) => {
				ticks.push(tick);
				return () => {};
			},
			now: () => new Date(clock)
		});
		await watch.looking();
		const reads = () => [host.stateReads.get(one.id) ?? 0, host.stateReads.get(two.id) ?? 0];
		expect(reads()).toEqual([1, 1]);
		expect(watch.known()).toEqual({ reader: 'has', fault: null });

		// every minute for the next hour: the cache is fresh, so nothing is asked
		for (let minute = 1; minute < 60; minute += 1) {
			clock = at.getTime() + minute * 60_000;
			ticks[0]?.();
			await watch.looking();
		}
		expect(reads()).toEqual([1, 1]);

		// an hour on, the pull request still open is asked again; the merged one is not
		host.merge(two);
		clock = at.getTime() + PULL_STATES_EVERY_MS;
		ticks[0]?.();
		await watch.looking();
		expect(reads()).toEqual([1, 2]);

		const view = measuresView(root, watch.known(), new Date(clock));
		// the second has a commit of a person's
		const { autonomy } = view.measures;
		expect(autonomy).toEqual({ kind: 'share', share: 0.5, merged: 2, autonomous: 1 });
		watch.stop();
	});

	it('says why autonomy is left out when the Code host has no pullState, and asks nothing', async () => {
		const host = new FakeCodeHost();
		await opened(host);
		const watch = watchMeasures({
			root,
			codeHost: () => Promise.resolve({}),
			changed: () => {},
			every: () => () => {},
			now: () => at
		});
		await watch.looking();
		expect(watch.known()).toEqual({ reader: 'none', fault: null });
		const view = measuresView(root, watch.known(), at);
		expect(view.measures.autonomy).toEqual({ kind: 'unavailable' });
		expect(view.note).toContain('no pullState');
		expect(host.stateReads.size).toBe(0);
		watch.stop();
	});

	it('says when it cannot open the Code host', async () => {
		const watch = watchMeasures({
			root,
			codeHost: () => Promise.reject(new Error('gh is signed out')),
			changed: () => {},
			every: () => () => {},
			now: () => at
		});
		await watch.looking();
		expect(watch.known()).toEqual({ reader: 'unread', fault: 'gh is signed out' });
		expect(measuresView(root, watch.known(), at).note).toContain('gh is signed out');
		watch.stop();
	});

	it('tells the page after each look, and stops looking when stopped', async () => {
		let told = 0;
		const ticks: (() => void)[] = [];
		const watch = watchMeasures({
			root,
			codeHost: () => Promise.resolve({}),
			changed: () => {
				told += 1;
			},
			every: (_ms, tick) => {
				ticks.push(tick);
				return () => {};
			},
			now: () => at
		});
		await watch.looking();
		expect(told).toBe(1);
		ticks[0]?.();
		await watch.looking();
		expect(told).toBe(2);
		watch.stop();
		ticks[0]?.();
		await watch.looking();
		expect(told).toBe(2);
	});
});

describe('measuresView', () => {
	it('says autonomy is not read yet before the Code host has been asked, with nothing to note', async () => {
		const host = new FakeCodeHost();
		await opened(host);
		const view = measuresView(root, NO_HOST_YET, at);
		expect(view.measures.autonomy).toEqual({ kind: 'not read' });
		expect(view.note).toBeNull();
	});

	it('notes the fault of the last read, which the cache file keeps, beside what it still shows', async () => {
		const host = new FakeCodeHost();
		const { one, two } = await opened(host);
		host.merge(one);
		const urls = [one.url, two.url];
		const path = measuresPath(root);
		await refreshPullStates({ path, codeHost: host, urls, now: at });
		const down = { pullState: () => Promise.reject(new Error('GitHub is down')) };
		const later = new Date(at.getTime() + PULL_STATES_EVERY_MS);
		await refreshPullStates({ path, codeHost: down, urls, now: later });
		const view = measuresView(root, NO_HOST_YET, later);
		expect(view.measures.autonomy).toMatchObject({ kind: 'share', merged: 1 });
		expect(view.note).toContain('GitHub is down');
	});
});

describe('the Measures panel as renderPanels draws it', () => {
	const panels = (known: CodeHostKnown) =>
		renderPanels(
			root,
			readFactory(root, { alive: () => true, now: () => at }),
			NO_LINKS,
			undefined,
			false,
			measuresView(root, known, at)
		);
	// the panel alone, from its section to the next
	const section = (html: string) =>
		html.split('<section id="measures">')[1]?.split('</section>')[0] ?? '';

	it('shows autonomy, the median time and cost per pull request, and the Sessions by outcome', async () => {
		const host = new FakeCodeHost();
		const { one, two } = await opened(host);
		host.merge(one);
		host.merge(two);
		await refreshPullStates({
			path: measuresPath(root),
			codeHost: host,
			urls: [one.url, two.url],
			now: at
		});
		const panel = section(panels(NO_HOST_YET));
		expect(panel).toContain('<h2>Measures <small>last 30 days</small></h2>');
		expect(panel).toContain(
			'<div class="stat"><span>autonomy</span> <b>50%</b> <small>1 of 2 merged</small></div>'
		);
		// the claim was half an hour before the draft pull request
		expect(panel).toContain(
			'<div class="stat"><span>time to pull request</span> <b>30m 00s</b> <small>median</small></div>'
		);
		expect(panel).toContain(
			'<div class="stat"><span>cost per pull request</span> <b>$1.50</b> <small>median</small></div>'
		);
		expect(panel).toContain('<div class="stat"><span>pull requests</span> <b>2</b></div>');
		expect(panel).toContain('<li>done <b>2</b></li>');
		expect(panel).not.toContain('class="empty"');
	});

	it('comes after Completed and before All Logbooks, in the overview', async () => {
		const host = new FakeCodeHost();
		await opened(host);
		const html = panels(NO_HOST_YET);
		expect(html.indexOf('<section id="completed">')).toBeLessThan(
			html.indexOf('<section id="measures">')
		);
		expect(html.indexOf('<section id="measures">')).toBeLessThan(
			html.indexOf('<section id="logbooks">')
		);
	});

	it('says autonomy is not read yet while the Code host has not been asked', async () => {
		const host = new FakeCodeHost();
		await opened(host);
		const panel = section(panels(NO_HOST_YET));
		expect(panel).toContain('<span>autonomy</span> <b>-</b> <small>not read yet</small>');
	});

	it('shows the panel without autonomy, and says why, for a Code host without pullState', async () => {
		const host = new FakeCodeHost();
		await opened(host);
		const panel = section(panels(NO_PULL_STATE));
		expect(panel).not.toContain('<span>autonomy</span>');
		expect(panel).toContain(
			'<p class="empty">Autonomy is not shown: this Code host cannot say which pull requests merged (it has no pullState).</p>'
		);
		expect(panel).toContain('<b>30m 00s</b>');
		expect(panel).toContain('<b>$1.50</b>');
	});

	it('says no pull request is merged yet when the Code host was asked and none is', async () => {
		const host = new FakeCodeHost();
		const { one, two } = await opened(host);
		await refreshPullStates({
			path: measuresPath(root),
			codeHost: host,
			urls: [one.url, two.url],
			now: at
		});
		const panel = section(panels(NO_HOST_YET));
		expect(panel).toContain('<span>autonomy</span> <b>-</b> <small>none merged yet</small>');
	});

	it('shows dashes and no Session for a repo with no history', () => {
		const panel = section(panels(NO_HOST_YET));
		expect(panel).toContain('<span>time to pull request</span> <b>-</b>');
		expect(panel).toContain('<span>cost per pull request</span> <b>-</b>');
		expect(panel).toContain('<p class="empty">no Session recorded</p>');
	});

	it('counts a Session by its kind of outcome, so none of its free text reaches the page', () => {
		mkdirSync(join(root, '.factory'), { recursive: true });
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/app',
			feature: '1',
			ticket: '1',
			branch: 'factory/1-a',
			step: 'build',
			session: 's-1',
			costUsd: 1,
			outcome: '<img src=x onerror=alert(1)>'
		});
		const panel = section(panels(NO_HOST_YET));
		expect(panel).not.toContain('img');
		expect(panel).toContain('<li>done <b>1</b></li>');
	});
});

describe('the Measures panel of nightjar ui', () => {
	const get = async (path: string) => {
		const got = await fetch(`http://127.0.0.1:${String(ui?.port)}${path}`);
		return got.text();
	};

	it('shows autonomy, the median time and cost per pull request, and the Sessions by outcome', async () => {
		const host = new FakeCodeHost();
		const { one, two } = await opened(host);
		host.merge(one);
		host.merge(two);
		ui = await startUi({
			root,
			port: 0,
			now: () => at,
			alive: () => true,
			codeHost: () => Promise.resolve(host)
		});
		await vi.waitFor(async () => {
			expect(await get('/')).toContain('<b>50%</b>');
		});
		const page = await get('/');
		expect(page).toContain('<h2>Measures <small>last 30 days</small></h2>');
		expect(page).toContain('<small>1 of 2 merged</small>');
		// the claim was half an hour before the draft pull request
		expect(page).toMatch(/time to pull request<\/span> <b>30m 00s<\/b>/);
		expect(page).toMatch(/cost per pull request<\/span> <b>\$1\.50<\/b>/);
		expect(page).toMatch(/<li>done <b>2<\/b><\/li>/);
	});

	it('shows the panel without autonomy, and says why, over a Code host without pullState', async () => {
		const host = new FakeCodeHost();
		await opened(host);
		ui = await startUi({
			root,
			port: 0,
			now: () => at,
			alive: () => true,
			codeHost: () => Promise.resolve({})
		});
		await vi.waitFor(async () => {
			expect(await get('/')).toContain('no pullState');
		});
		const page = await get('/');
		expect(page).not.toContain('<span>autonomy</span>');
		expect(page).toMatch(/time to pull request<\/span> <b>30m 00s<\/b>/);
		expect(page).toMatch(/cost per pull request<\/span> <b>\$1\.50<\/b>/);
	});

	it('shows the panel, without autonomy, when the page is given no Code host', async () => {
		const host = new FakeCodeHost();
		await opened(host);
		ui = await startUi({ root, port: 0, now: () => at, alive: () => true });
		const page = await get('/');
		expect(page).toContain('id="measures"');
		expect(page).not.toContain('<span>autonomy</span>');
		expect(measuresView(root, NO_PULL_STATE, at).note).toContain('no pullState');
	});

	it('shows an empty panel for a repo with no history', async () => {
		mkdirSync(join(root, '.factory'), { recursive: true });
		writeFileSync(ledgerFile(), '');
		ui = await startUi({ root, port: 0, now: () => at, alive: () => true });
		const page = await get('/');
		expect(page).toContain('no Session recorded');
		expect(page).toMatch(/time to pull request<\/span> <b>-<\/b>/);
	});
});
