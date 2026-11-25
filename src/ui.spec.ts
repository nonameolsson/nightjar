import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileSpend, record } from './ledger.js';
import { readLogbook, readSession } from './logbook-reader.js';
import { fileLogbook, type Decision, type Place } from './logbook.js';
import { featureAfterRunStep, ticketStep } from './next-step.js';
import { FakeTracker } from './fakes/tracker.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';
import { StatusFile } from './status.js';
import { readFactory } from './status-reader.js';
import { logbookPage, renderPanels, sessionPage, startUi, type Ui } from './ui.js';
import { NO_LINKS } from './ui-links.js';
import { PAPER_STYLE, THEMES, type Theme } from './ui-theme.js';
import {
	detailFrom,
	listsFrom,
	TRACKER_EVERY_MS,
	type ReadingTracker,
	type Upcoming
} from './ui-tracker.js';

let root: string;
let ui: Ui | null;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-ui-'));
	ui = null;
});
afterEach(async () => {
	await ui?.close();
	rmSync(root, { recursive: true, force: true });
});

const at = new Date(2026, 9, 30, 9, 0);
const ledgerFile = () => join(root, '.factory', 'runs.jsonl');
const status = (watching = false) =>
	new StatusFile({
		path: join(root, '.factory', 'status.json'),
		spend: fileSpend(ledgerFile()),
		now: () => at,
		pid: 42,
		dailyUsd: 8,
		watching
	});

let alive = true;
beforeEach(() => {
	alive = true;
});
const open = async () => {
	ui = await startUi({ root, port: 0, now: () => at, alive: () => alive });
	return ui;
};
const get = async (path: string, method = 'GET') => {
	const got = await fetch(`http://127.0.0.1:${String(ui?.port)}${path}`, { method });
	return { status: got.status, text: await got.text() };
};

// the page asks the browser whether it is in reflow mode; the specs say it is not
const noMedia = () => ({ matches: false, addEventListener: () => {} });

describe('nightjar ui page', () => {
	it('binds 127.0.0.1 only and, with no .factory/, shows the run as off with nothing else', async () => {
		const { address } = await open();
		expect(address).toBe('127.0.0.1');
		const page = await get('/');
		expect(page.status).toBe(200);
		expect(page.text).toContain('off');
		expect(page.text).toContain('Completed');
		expect(page.text).toContain('nothing has finished yet');
	});

	it('shows a watching run: next poll, spend against the limit, built today, and the Queue', async () => {
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/falcon',
			feature: '7',
			ticket: '8',
			branch: 'b',
			step: 'build',
			session: 's',
			costUsd: 3.5,
			outcome: 'built'
		});
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: '2026-10-30T07:02:00.000Z' });
		file.refreshed(
			[
				{ id: '275', title: 'Saved filters' },
				{ id: '281', title: 'CSV <export>' }
			],
			{ items: [], trackerCannotList: false }
		);
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('o/falcon');
		expect(page).toContain('<span class="state">idle</span>');
		expect(page).toContain('data-until="2026-10-30T07:02:00.000Z"');
		expect(page).toContain('$3.50');
		expect(page).toContain('$8.00');
		expect(page).toMatch(/built today[^]*?<b>1<\/b>/);
		expect(page).toContain('#275');
		expect(page).toContain('Saved filters');
		// a title is text, never markup
		expect(page).toContain('CSV &#60;export&#62;');
		expect(page).not.toContain('<export>');
	});

	it('shows a queued Feature with its Ticket count, its closed Tickets built, and its eggs', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.refreshed(
			[
				{ id: '275', title: 'Saved filters', ticketCounts: { total: 4, closed: 1 } },
				{ id: '281', title: 'Exports', ticketCounts: null },
				{ id: '290', title: 'Reports' }
			],
			{ items: [], trackerCannotList: false }
		);
		await open();
		const board = (await get('/')).text.split('<div class="table">')[0] ?? '';
		const card = (title: string) => board.split('<article').find((a) => a.includes(title)) ?? '';
		expect(card('Saved filters')).toContain('4 Tickets');
		expect(card('Saved filters')).toContain('1 of 4 built');
		expect(card('Saved filters')).toContain('class="eggs"');
		expect(card('Exports')).toContain('? Tickets');
		expect(card('Exports')).not.toContain('class="eggs"');
		expect(card('Reports')).not.toContain('Tickets');
		expect(card('Reports')).not.toContain('class="eggs"');
	});

	describe('estimate', () => {
		const built = (
			ticket: string | null,
			durationMs: number | undefined,
			minute: number,
			step: 'build' | 'fix' | 'review' = 'build'
		) =>
			record(ledgerFile(), {
				at: new Date(2026, 9, 30, 8, minute).toISOString(),
				repo: 'o/r',
				feature: '1',
				ticket,
				branch: 'b',
				step,
				session: 's',
				costUsd: 1,
				outcome: step === 'build' ? 'built' : 'approve',
				...(durationMs === undefined ? {} : { durationMs })
			});
		const queue = (closed = 0) => {
			const file = status();
			file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
			file.refreshed(
				[
					{ id: '275', title: 'Saved filters', ticketCounts: { total: 4, closed } },
					{ id: '281', title: 'Exports', ticketCounts: null },
					{ id: '290', title: 'Reports' }
				],
				{ items: [], trackerCannotList: false }
			);
		};
		const cardOf = (page: string, title: string) =>
			(page.split('<div class="table">')[0] ?? '')
				.split('<article')
				.find((a) => a.includes(title)) ?? '';

		it('shows the median Ticket duration times the Ticket count, marked est., on a queued card and row', async () => {
			built('11', 60_000, 1);
			built('12', 300_000, 2);
			built('13', 120_000, 3);
			built('14', undefined, 4);
			built('13', 60_000, 5, 'fix');
			built(null, 90_000, 6, 'review');
			queue();
			await open();
			const page = (await get('/')).text;
			// a Ticket's build and fix rounds, plus its share of the review over the 4 built: 1m22.5s, 5m22.5s, 3m22.5s
			// median 3m22.5s x 4 Tickets
			expect(cardOf(page, 'Saved filters')).toMatch(/13m 30s<\/time> <small>est\./);
			expect(cardOf(page, 'Exports')).not.toContain('est.');
			expect(cardOf(page, 'Reports')).not.toContain('est.');
			const rows = (page.split('<tbody>')[1] ?? '').split('<tr');
			expect(rows.find((r) => r.includes('Saved filters'))).toContain('est.');
			expect(rows.find((r) => r.includes('Exports'))).not.toContain('est.');
		});

		it('counts only the Tickets not built yet, and gives none when all are', async () => {
			built('11', 60_000, 1);
			queue(2);
			await open();
			// 1m x the 2 Tickets left
			expect(cardOf((await get('/')).text, 'Saved filters')).toMatch(/2m 00s<\/time> <small>est\./);
			queue(4);
			expect(cardOf((await get('/')).text, 'Saved filters')).not.toContain('est.');
		});

		it('shows no estimate while no duration is recorded', async () => {
			built('11', undefined, 1);
			queue();
			await open();
			expect((await get('/')).text).not.toContain('est.');
		});
	});

	it('shows progress on Waiting on you and Completed, in the Board and the Table', async () => {
		const built = (feature: string, ticket: string, minute: number) =>
			record(ledgerFile(), {
				at: new Date(2026, 9, 30, 8, minute).toISOString(),
				repo: 'o/r',
				feature,
				ticket,
				branch: 'b',
				step: 'build',
				session: 's',
				costUsd: 1,
				outcome: 'built'
			});
		built('9', '91', 1);
		built('9', '92', 2);
		built('9', '93', 3);
		built('8', '81', 4);
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		const queued = [{ id: '8', title: 'Retry', ticketCounts: { total: 5, closed: 0 } }];
		const items = [
			{
				kind: 'feature' as const,
				id: '7',
				title: 'Billing',
				why: 'needs info',
				ticketCounts: { total: 6, closed: 2 }
			},
			{
				kind: 'feature' as const,
				id: '6',
				title: 'Unknown',
				why: 'needs a person',
				ticketCounts: null
			}
		];
		file.refreshed(queued, { items, trackerCannotList: false });
		const url = 'https://example.test/pull/9';
		file.happened({
			kind: 'pull',
			feature: '9',
			title: 'Done one',
			url,
			tickets: { built: 3, total: 4 }
		});
		// an older status file: no Tickets on the event
		file.happened({ kind: 'pull', feature: '5', title: 'Old one', url });
		file.happened({ kind: 'failed', feature: '8', title: 'Retry', why: 'it broke' });
		await open();
		const page = (await get('/')).text;
		const [board = '', rest = ''] = page.split('<div class="table">');
		const table = rest.split('<div class="overview">')[0] ?? '';
		const card = (html: string, title: string) =>
			html.split('<article').find((a) => a.includes(title)) ?? '';
		const row = (title: string) => table.split('<tr ').find((a) => a.includes(title)) ?? '';
		// each bar says what it counts: what is built now, or what a past run built
		expect(card(board, 'Billing')).toContain('2 of 6 built now');
		expect(card(board, 'Billing')).toContain('aria-label="2 of 6 built now"');
		expect(card(board, 'Billing')).toContain('class="eggs"');
		expect(card(board, 'Unknown')).toContain('>count unknown<');
		expect(card(board, 'Unknown')).not.toContain('class="eggs"');
		// the ledger holds 3 built sessions, but the branch is 3 of the Feature's 4
		expect(card(board, 'Done one')).toContain('3 of 4 built by the end of this run');
		expect(card(board, 'Old one')).toContain('>count unknown<');
		// #8 failed and is queued again: it sits in the Queue, its failed run on its card
		expect(card(board, 'Retry')).toContain('entry queue');
		expect(card(board, 'Retry')).toContain(
			'1 earlier run, the latest failed (1 of 5 built in this run)'
		);
		expect(row('Billing')).toContain('2 of 6 built now');
		expect(row('Done one')).toContain('3 of 4 built by the end of this run');
		expect(row('Unknown')).not.toContain('class="eggs"');
	});

	it('says stopped when the pid is gone, and shows no Queue then, only history', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.refreshed([{ id: '275', title: 'Saved filters' }], {
			items: [],
			trackerCannotList: false
		});
		file.happened({ kind: 'pull', feature: '9', url: 'https://example.test/pull/9' });
		alive = false;
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('stopped');
		expect(page).not.toContain('Saved filters');
		expect(page).toContain('href="https://example.test/pull/9"');
	});

	it('shows the current build: Ticket progress, step and round, its clock, cost and the session tail', async () => {
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/r',
			feature: '272',
			ticket: '1',
			branch: 'b',
			step: 'build',
			session: 'sess',
			costUsd: 1.18,
			outcome: 'built'
		});
		const lines = Array.from({ length: 25 }, (_, i) => ({
			type: 'assistant',
			message: { content: [{ type: 'text', text: `line ${String(i + 1)}` }] }
		}));
		mkdirSync(join(root, '.factory', 'logs'), { recursive: true });
		writeFileSync(
			join(root, '.factory', 'logs', 'sess.jsonl'),
			lines.map((l) => JSON.stringify(l)).join('\n')
		);
		status().doing({
			kind: 'building',
			feature: '272',
			title: 'Custom <views>',
			ticket: '3',
			step: 'build',
			round: 1,
			rounds: 3,
			session: 'sess',
			startedAt: '2026-10-30T06:48:00.000Z',
			tickets: [
				{ id: '1', title: 'Models', state: 'built' },
				{ id: '3', title: 'Views list', state: 'building' },
				{ id: '4', title: 'Share links', state: 'waiting', why: 'waits for #3' }
			]
		});
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('<span class="state">watching</span>');
		expect(page).toContain('#272');
		expect(page).toContain('Custom &#60;views&#62;');
		expect(page).toContain('data-since="2026-10-30T06:48:00.000Z"');
		expect(page).toContain('Ticket 2 of 3');
		expect(page).toContain('build, round 1 of 3');
		expect(page).toContain('$1.18');
		expect(page).toContain('Views list');
		expect(page).toContain('waits for #3');
		// the newest 20 session lines, not the first five
		expect(page).toContain('line 25');
		expect(page).toContain('line 6\n');
		expect(page).not.toContain('line 5\n');
	});

	it('shows a Feedback round while it runs, and what it has cost so far', async () => {
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/r',
			feature: '272',
			ticket: null,
			branch: 'b',
			step: 'feedback',
			session: 'sess',
			costUsd: 2.25,
			outcome: 'answered 1 of 1'
		});
		status().doing({
			kind: 'building',
			feature: '272',
			title: 'Custom views',
			ticket: null,
			step: 'feedback',
			round: 1,
			rounds: 3,
			session: 'sess',
			startedAt: '2026-10-30T06:48:00.000Z'
		});
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('Feedback round, round 1 of 3');
		expect(page).toContain('$2.25');
	});

	it('shows a Review round while it runs, and what it has cost so far', async () => {
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/r',
			feature: '272',
			ticket: null,
			branch: 'b',
			step: 'reviewRound',
			session: 'sess',
			costUsd: 1.75,
			outcome: 'fixed'
		});
		status().doing({
			kind: 'building',
			feature: '272',
			title: 'Custom views',
			ticket: null,
			step: 'reviewRound',
			round: 2,
			rounds: 2,
			session: 'sess',
			startedAt: '2026-10-30T06:48:00.000Z'
		});
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('Review round, round 2 of 2');
		expect(page).not.toContain('reviewRound');
		expect(page).toContain('$1.75');
	});

	it('shows a Pull-check fix round while it runs, and what it has cost so far', async () => {
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/r',
			feature: '272',
			ticket: null,
			branch: 'b',
			step: 'pullChecks',
			session: 'sess',
			costUsd: 1.5,
			outcome: 'pull checks 1'
		});
		status().doing({
			kind: 'building',
			feature: '272',
			title: 'Custom views',
			ticket: null,
			step: 'pullChecks',
			round: 1,
			rounds: 2,
			session: 'sess',
			startedAt: '2026-10-30T06:48:00.000Z'
		});
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('<span class="state">watching</span>');
		expect(page).toContain('Pull-check fix, round 1 of 2');
		expect(page).not.toContain('pullChecks');
		expect(page).toContain('$1.50');
	});

	it("counts the Feature's elapsed time from its start, not the step's", async () => {
		status().doing({
			kind: 'building',
			feature: '272',
			ticket: null,
			step: 'review',
			round: null,
			rounds: null,
			session: null,
			featureStartedAt: '2026-10-30T06:00:00.000Z',
			startedAt: '2026-10-30T06:40:00.000Z'
		});
		await open();
		expect((await get('/')).text).toContain('data-since="2026-10-30T06:00:00.000Z"');
	});

	it('says under --watch that the next poll comes after the Feature being built', async () => {
		const building = {
			kind: 'building',
			feature: '272',
			ticket: null,
			step: 'setup',
			round: null,
			rounds: null,
			session: null,
			startedAt: at.toISOString()
		} as const;
		status(true).doing(building);
		await open();
		expect((await get('/')).text).toContain('next poll after #272');
		status(false).doing(building);
		expect((await get('/')).text).not.toContain('next poll');
	});

	it("counts its own clocks in the browser with the terminal's formatting", async () => {
		await open();
		const page = (await get('/')).text;
		const script = page.split('<script>')[1]?.split('</script>')[0] ?? '';
		const now = Date.parse('2026-10-30T08:00:00.000Z');
		const since = { dataset: { since: '2026-10-30T06:57:55.000Z' }, textContent: '' };
		const until = { dataset: { until: '2026-10-30T08:01:12.000Z' }, textContent: '' };
		runInNewContext(script, {
			matchMedia: noMedia,
			document: {
				getElementById: () => ({ dataset: {} }),
				querySelectorAll: (q: string) => (q.includes('since') ? [since] : [until])
			},
			EventSource: function EventSource() {
				return {};
			},
			setInterval: () => 0,
			Date: { now: () => now, parse: Date.parse }
		});
		expect([since.textContent, until.textContent]).toEqual(['1h 02m', '1:12']);
	});

	it('lists what waits on you, and says so when the Tracker cannot list Features', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.refreshed([], {
			items: [{ kind: 'feature', id: '268', title: 'Webhook retries', why: 'needs info' }],
			trackerCannotList: false
		});
		await open();
		let page = (await get('/')).text;
		expect(page).toContain('Waiting on you');
		expect(page).toContain('Webhook retries');
		expect(page).toContain('needs info');
		file.refreshed([], { items: [], trackerCannotList: true });
		page = (await get('/')).text;
		expect(page).toContain('not available from this Tracker');
	});

	it('shows a failure with why, a title when the event has one, and never links a non-http url', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.happened({ kind: 'failed', feature: '249', why: 'check red' });
		file.happened({ kind: 'pull', feature: '259', url: 'javascript:alert(1)' });
		const written = JSON.parse(readFileSync(join(root, '.factory', 'status.json'), 'utf8')) as {
			recent: { feature: string; title?: string }[];
		};
		for (const e of written.recent) if (e.feature === '249') e.title = 'Auth rewrite';
		writeFileSync(join(root, '.factory', 'status.json'), JSON.stringify(written));
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('Auth rewrite');
		expect(page).toContain('failed: check red');
		expect(page).not.toContain('href="javascript');
	});

	it('changes nothing: only GET and HEAD are answered, and only /, /events and /sessions/ID', async () => {
		await open();
		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
			expect((await get('/', method)).status).toBe(405);
		}
		expect((await get('/events', 'POST')).status).toBe(405);
		expect((await get('/status.json')).status).toBe(404);
		expect((await get('/', 'HEAD')).status).toBe(200);
	});

	it('refuses a request whose Host is not this machine, so a rebound DNS name reads nothing', async () => {
		await open();
		const got = await new Promise<number>((done) => {
			const req = request(
				{ host: '127.0.0.1', port: ui?.port, path: '/', headers: { host: 'evil.example' } },
				(res) => {
					res.resume();
					done(res.statusCode ?? 0);
				}
			);
			req.end();
		});
		expect(got).toBe(403);
	});
});

describe('nightjar ui reads the Tracker', () => {
	// each read a minute would bring, which a spec calls itself instead of waiting
	let minutes: { ms: number; read: () => void }[];
	let reads: number;
	beforeEach(() => {
		minutes = [];
		reads = 0;
	});
	const every = (ms: number, read: () => void) => {
		minutes.push({ ms, read });
		return () => {};
	};
	// #1 with the Go and two Tickets, one closed; #4 a lone issue that needs info
	const fakeTracker = () =>
		new FakeTracker('ann', () => at)
			.add({
				id: '1',
				title: 'Saved filters',
				assignees: ['ann'],
				signals: ['go'],
				children: ['2', '3']
			})
			.add({ id: '2', title: 'Model', open: false })
			.add({ id: '3', title: 'View' })
			.add({ id: '4', title: 'Audit log', assignees: ['ann'], signals: ['needsInfo'] });
	const readsOf = (tracker: ReadingTracker, fail: () => boolean = () => false) => {
		const read = listsFrom(
			() => Promise.resolve({ tracker, person: 'ann' }),
			() => at
		);
		return (): Promise<Upcoming> => {
			reads += 1;
			return fail() ? Promise.reject(new Error('gh: Bad Gateway (HTTP 502)')) : read();
		};
	};
	const openOn = async (tracker: () => Promise<Upcoming>) => {
		ui = await startUi({ root, port: 0, now: () => at, alive: () => alive, tracker, every });
		return ui;
	};
	const page = async () => (await get('/')).text;
	// the page once its first read of the Tracker has ended
	const read = async () => {
		await vi.waitFor(async () => expect(await page()).not.toContain('reading the Tracker'));
		return page();
	};
	const board = (html: string) => html.split('<div class="table">')[0] ?? '';
	const mat = (html: string, state: string) =>
		board(html).split(`<section class="mat" data-state="${state}"`)[1]?.split('<section')[0] ?? '';

	it('shows the Queue and Waiting on you while nightjar is off, and when it read them', async () => {
		const tracker = fakeTracker();
		const before = structuredClone([...tracker.items.values()]);
		await openOn(readsOf(tracker));
		const html = await read();
		expect(html).toContain('<span class="state">off</span>');
		expect(html).not.toContain('not known while nightjar is off');
		expect(mat(html, 'queue')).toContain('Saved filters');
		expect(mat(html, 'queue')).toContain('1 of 2 built');
		expect(mat(html, 'waiting')).toContain('Audit log');
		expect(mat(html, 'waiting')).toContain('needs info');
		expect(html).toMatch(/waiting on you<\/span> <b>1<\/b>/);
		expect(html).toContain(`Tracker read <time datetime="${at.toISOString()}">`);
		// the Table and Overview read the same lists
		expect(html.split('<div class="table">')[1]).toContain('data-title="Saved filters"');
		expect(html.split('<div class="overview">')[1]).toContain('Audit log');
		// read-only: nothing on the Tracker changed
		expect([...tracker.items.values()]).toEqual(before);
	});

	it('takes a Feature off Waiting on you once it builds, before the next read says so', async () => {
		const tracker = fakeTracker();
		await openOn(readsOf(tracker));
		await read();
		status(true).doing({
			kind: 'building',
			feature: '4',
			title: 'Audit log',
			ticket: null,
			step: 'setup',
			round: 1,
			rounds: 3,
			session: null,
			startedAt: at.toISOString()
		});
		await vi.waitFor(async () => expect(mat(await page(), 'building')).toContain('Audit log'));
		const html = await page();
		expect(mat(html, 'waiting')).not.toContain('Audit log');
		expect(html).toMatch(/waiting on you<\/span> <b>0<\/b>/);
	});

	it('reads on open and then once a minute, never on a change under .factory/', async () => {
		const tracker = fakeTracker();
		await openOn(readsOf(tracker));
		await read();
		expect(reads).toBe(1);
		expect(minutes.map((m) => m.ms)).toEqual([TRACKER_EVERY_MS]);
		expect(TRACKER_EVERY_MS).toBe(60_000);
		status().doing({ kind: 'idle', nextPollAt: at.toISOString() });
		await vi.waitFor(async () => expect(await page()).toContain('<span class="state">idle'));
		tracker.add({ id: '5', title: 'Reports', assignees: ['ann'], signals: ['go'] });
		await new Promise((done) => setTimeout(done, 100));
		expect(reads).toBe(1);
		expect(await page()).not.toContain('Reports');
		minutes[0]?.read();
		await vi.waitFor(async () => expect(mat(await page(), 'queue')).toContain('Reports'));
		expect(reads).toBe(2);
	});

	it('keeps the last lists when a read fails, marked with their age, and stays up', async () => {
		let down = false;
		await openOn(readsOf(fakeTracker(), () => down));
		await read();
		down = true;
		minutes[0]?.read();
		await vi.waitFor(async () => expect(await page()).toContain('Bad Gateway'));
		const got = await get('/');
		expect(got.status).toBe(200);
		expect(mat(got.text, 'queue')).toContain('Saved filters');
		expect(mat(got.text, 'waiting')).toContain('Audit log');
		const header = got.text.split('<header>')[1]?.split('</header>')[0] ?? '';
		expect(header).toContain('class="read stale"');
		expect(header).toContain(`<time data-since="${at.toISOString()}"></time> ago`);
		expect(header).toContain('could not read it at');
		// the next read that goes well clears the mark
		down = false;
		minutes[0]?.read();
		await vi.waitFor(async () => expect(await page()).not.toContain('Bad Gateway'));
	});

	it('says why when no read has gone well yet, in place of the lists', async () => {
		await openOn(readsOf(fakeTracker(), () => true));
		const html = await read();
		expect(mat(html, 'queue')).toContain('could not read the Tracker: gh: Bad Gateway');
		expect(mat(html, 'waiting')).toContain('could not read the Tracker');
		expect(html).not.toContain('not known while nightjar is off');
	});

	it('still says Waiting on you is not available from a Tracker without waitingOn', async () => {
		const fake = fakeTracker();
		const tracker: ReadingTracker = { assignedFeatures: (p) => fake.assignedFeatures(p) };
		await openOn(readsOf(tracker));
		const html = await read();
		expect(mat(html, 'waiting')).toContain('not available from this Tracker');
		expect(mat(html, 'queue')).toContain('Saved filters');
		// no counts from a Tracker that cannot count
		expect(mat(html, 'queue')).not.toContain('Tickets');
	});

	it("shows the person's Shelf while nightjar is off, and says so when the Tracker cannot list it", async () => {
		const fake = fakeTracker().add({ id: '6', title: 'Old idea', assignees: ['ann'] });
		await openOn(readsOf(fake));
		const html = await read();
		expect(mat(html, 'shelf')).toContain('Old idea');
		expect(mat(html, 'shelf')).toContain('Lone issue');
		expect(html.split('<div class="overview">')[1]).toContain('Old idea');
		await ui?.close();
		const without: ReadingTracker = {
			assignedFeatures: (p) => fake.assignedFeatures(p),
			waitingOn: (p) => fake.waitingOn(p)
		};
		await openOn(readsOf(without));
		const bare = await read();
		expect(mat(bare, 'shelf')).toContain('Shelf is not available from this Tracker');
		expect(mat(bare, 'queue')).toContain('Saved filters');
	});

	it("takes the Tracker's lists over status.json's, keeps the run's waiting Tickets, and queues no Feature being built", async () => {
		const file = status();
		file.refreshed([{ id: '50', title: 'Old queue' }], { items: [], trackerCannotList: false });
		// while a Feature builds, status.json lists its own Tickets that wait
		file.doing({
			kind: 'building',
			feature: '1',
			title: 'Saved filters',
			ticket: '3',
			step: 'build',
			round: null,
			rounds: null,
			session: null,
			startedAt: at.toISOString(),
			tickets: [
				{ id: '3', title: 'View', state: 'building' },
				{ id: '12', title: 'Facets', state: 'waiting', why: 'needs info' }
			]
		});
		await openOn(readsOf(fakeTracker()));
		const html = await read();
		expect(html).not.toContain('Old queue');
		expect(mat(html, 'queue')).not.toContain('Saved filters');
		expect(mat(html, 'building')).toContain('Saved filters');
		expect(mat(html, 'waiting')).toContain('Audit log');
		// the building Feature's waiting Ticket sits on its Building card
		expect(mat(html, 'building')).toContain('Facets');
		expect(mat(html, 'waiting')).not.toContain('Facets');
	});

	it('answers GET and HEAD only, as before', async () => {
		await openOn(readsOf(fakeTracker()));
		await read();
		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
			expect((await get('/', method)).status).toBe(405);
		}
		expect((await get('/', 'HEAD')).status).toBe(200);
	});

	describe('the Feature detail panel', () => {
		const openWithPanel = async (tracker: FakeTracker) => {
			const page = () => Promise.resolve({ tracker, person: 'ann', workflows: [] });
			ui = await startUi({
				root,
				port: 0,
				now: () => at,
				alive: () => alive,
				tracker: listsFrom(page, () => at),
				feature: detailFrom(page),
				every
			});
			return ui;
		};

		it('opens from a Feature on Waiting on you, the Queue or the Shelf, read through a GET route when it opens', async () => {
			const tracker = fakeTracker().add({ id: '6', title: 'Old idea', assignees: ['ann'] });
			const before = structuredClone([...tracker.items.values()]);
			await openWithPanel(tracker);
			const html = await read();
			for (const [state, id] of [
				['queue', '1'],
				['waiting', '4'],
				['shelf', '6']
			] as const)
				expect(mat(html, state)).toContain(`data-feature="${id}"`);
			expect(html).toContain('<dialog id="feature"');
			const panel = await get('/feature?id=1');
			expect(panel.status).toBe(200);
			expect(panel.text).toContain('Tickets in Build order');
			expect(panel.text).toContain('Model');
			expect(panel.text).toContain('<details class="criteria">');
			// the Ticket contract check, as `nightjar doctor` runs it
			expect(panel.text).toMatch(/\d+ of \d+ open Tickets? meets? the Ticket contract/);
			const lone = await get('/feature?id=4');
			expect(lone.text).toContain('Lone issue');
			// read-only: nothing on the Tracker changed
			expect([...tracker.items.values()]).toEqual(before);
		});

		it('shows an error in the panel when the read fails, and still answers nothing but GET and HEAD', async () => {
			await openWithPanel(fakeTracker());
			await read();
			const missing = await get('/feature?id=404');
			expect(missing.status).toBe(502);
			expect(missing.text).toContain('could not read #404 from the Tracker');
			for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'])
				expect((await get('/feature?id=1', method)).status).toBe(405);
			expect((await get('/feature?id=1', 'HEAD')).status).toBe(200);
		});

		it('has no route when the page reads no Feature', async () => {
			await openOn(readsOf(fakeTracker()));
			const html = await read();
			expect(html).not.toContain('data-feature=');
			expect((await get('/feature?id=1')).status).toBe(404);
		});
	});
});

// The next server-sent event of a stream, as the panels it carries.
async function nextPanels(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const { value } = await reader.read();
	const text = new TextDecoder().decode(value);
	expect(text).toMatch(/^data: /);
	return JSON.parse(text.slice('data: '.length)) as string;
}

describe('nightjar ui events', () => {
	it('sends the panels on connect and again when a file under .factory/ changes', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		await open();
		const events = await fetch(`http://127.0.0.1:${String(ui?.port)}/events`);
		expect(events.headers.get('content-type')).toBe('text/event-stream');
		const reader = (events.body as ReadableStream<Uint8Array>).getReader();
		expect(await nextPanels(reader)).toContain('idle');
		file.happened({ kind: 'failed', feature: '12', why: 'check red' });
		expect(await nextPanels(reader)).toContain('failed: check red');
		await reader.cancel();
	});

	it('serves the page with the script that opens /events and ticks its own clocks', async () => {
		await open();
		const page = (await get('/')).text;
		expect(page).toContain("new EventSource('/events')");
		expect(page).toContain('data-since');
	});
});

describe('nightjar ui board', () => {
	it('opens on a Board of five Mats with a card per Feature, and keeps Overview', async () => {
		const file = status();
		file.doing({
			kind: 'building',
			feature: '5',
			title: 'Search',
			ticket: '7',
			step: 'build',
			round: 1,
			rounds: 3,
			session: null,
			startedAt: at.toISOString(),
			tickets: [
				{ id: '6', title: 'Index', state: 'built' },
				{ id: '7', title: 'Query', state: 'building' },
				{ id: '8', title: 'Facets', state: 'waiting', why: 'needs info' }
			]
		});
		file.refreshed([{ id: '9', title: 'Exports' }], {
			items: [
				{ kind: 'feature', id: '3', title: 'Webhooks', why: 'needs a person' },
				{ kind: 'ticket', id: '8', title: 'Facets', why: 'needs info' }
			],
			trackerCannotList: false
		});
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('<main id="panels" data-view="board" tabindex="-1">');
		for (const name of ['Queue', 'Shelf', 'Building', 'Waiting on you', 'Completed'])
			expect(page).toContain(`<h2>${name}</h2>`);
		expect(page).toContain('Exports');
		expect(page).toContain('Ticket 2 of 3, build, round 1 of 3');
		expect(page).toContain('<li class="built">');
		expect(page).toContain('Webhooks');
		expect(page).toContain('Facets <small>needs info</small>');
		expect(page).toContain('<h2>Current build</h2>');
		const board = page.split('<div class="board">')[1]?.split('<div class="table">')[0] ?? '';
		const card = board.split('<article').find((a) => a.includes('entry building')) ?? '';
		// one egg per Ticket: built, being built, needs a person
		expect(card).toContain(
			'<i class="slot"><i class="egg built"></i></i><i class="slot"><i class="egg building"></i></i><i class="slot"><i class="egg need"></i></i>'
		);
		expect(card).toContain('1 of 3 built now');
	});

	it("lists a building Feature's waiting Tickets on its Building card, not on a Waiting card of its own", async () => {
		const file = status(true);
		file.refreshed([], { items: [], trackerCannotList: false });
		file.doing({
			kind: 'building',
			feature: '5',
			title: 'Search',
			ticket: '7',
			step: 'build',
			round: 1,
			rounds: 3,
			session: null,
			startedAt: at.toISOString(),
			tickets: [
				{ id: '7', title: 'Query', state: 'building' },
				{ id: '8', title: 'Facets', state: 'waiting', why: 'needs info' }
			]
		});
		await open();
		const page = (await get('/')).text;
		const [board = '', rest = ''] = page.split('<div class="table">');
		const table = rest.split('<div class="overview">')[0] ?? '';
		const cards = board
			.split('<article')
			.slice(1)
			.map((a) => a.split('</article>')[0] ?? '');
		expect(cards.filter((a) => a.includes('Search'))).toHaveLength(1);
		const card = cards.find((a) => a.includes('entry building')) ?? '';
		expect(card).toContain('Facets <small>needs info</small>');
		expect(page).toContain('<h2>Waiting on you</h2><i class="tally">0</i>');
		// the header still counts the Ticket: it waits on the person
		expect(page).toMatch(/waiting on you<\/span> <b>1<\/b>/);
		const rows = table.split('<tr ').filter((r) => r.includes('Search'));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain('needs info');
	});

	it('shows one Completed card per Feature: its latest run and how many runs it had', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		const url = (n: number) => `https://example.test/pull/${String(n)}`;
		file.happened({ kind: 'failed', feature: '132', title: 'Retries', why: 'check red' });
		file.happened({ kind: 'pull', feature: '147', title: 'Exports', url: url(40) });
		file.happened({ kind: 'pull', feature: '132', title: 'Retries', url: url(41) });
		file.happened({ kind: 'pull', feature: '132', title: 'Retries', url: url(42) });
		await open();
		const page = (await get('/')).text;
		const [board = '', rest = ''] = page.split('<div class="table">');
		const [table = '', overview = ''] = rest.split('<div class="overview">');
		const cards = board.split('<article').filter((a) => a.includes('Retries'));
		expect(cards).toHaveLength(1);
		expect(cards[0]).toContain('pull/42"');
		expect(cards[0]).not.toContain('pull/41"');
		expect(cards[0]).toContain('latest of 3 recent runs');
		expect(board.split('<article').find((a) => a.includes('Exports'))).toContain('1 recent run');
		// newest first: the latest run of #132 came after #147's
		expect(board.indexOf('Retries')).toBeLessThan(board.indexOf('Exports'));
		expect(page).toContain('<h2>Completed</h2><i class="tally">2</i>');
		expect(table.split('<tr ').filter((r) => r.includes('Retries'))).toHaveLength(1);
		expect(table).toContain('latest of 3 recent runs');
		expect(overview.split('<li>').filter((r) => r.includes('Retries'))).toHaveLength(1);
	});

	it('shows a Feature built again on one Mat, where it is now, with its earlier runs on its card', async () => {
		const file = status(true);
		const url = (n: number) => `https://example.test/pull/${String(n)}`;
		file.happened({ kind: 'pull', feature: '278', title: 'Library', url: url(40) });
		file.happened({ kind: 'pull', feature: '278', title: 'Library', url: url(41) });
		file.happened({ kind: 'failed', feature: '190', title: 'Several', why: 'push refused' });
		file.happened({ kind: 'pull', feature: '9', title: 'Exports', url: url(42) });
		file.happened({ kind: 'pull', feature: '147', title: 'Retries', url: url(43) });
		file.doing({
			kind: 'building',
			feature: '278',
			title: 'Library',
			ticket: null,
			step: 'setup',
			round: 1,
			rounds: 3,
			session: null,
			startedAt: at.toISOString()
		});
		file.refreshed([{ id: '9', title: 'Exports' }], {
			items: [{ kind: 'feature', id: '190', title: 'Several', why: 'needs info' }],
			trackerCannotList: false
		});
		await open();
		const page = (await get('/')).text;
		const [board = '', rest = ''] = page.split('<div class="table">');
		const [table = '', overview = ''] = rest.split('<div class="overview">');
		const cards = (title: string) =>
			board
				.split('<article')
				.slice(1)
				.map((a) => a.split('</article>')[0] ?? '')
				.filter((a) => a.includes(title));
		for (const title of ['Library', 'Several', 'Exports', 'Retries'])
			expect(cards(title)).toHaveLength(1);
		expect(cards('Library')[0]).toContain('entry building');
		expect(cards('Library')[0]).toContain('2 earlier runs');
		expect(cards('Library')[0]).toContain('pull/41"');
		expect(cards('Several')[0]).toContain('entry waiting');
		expect(cards('Several')[0]).toContain('1 earlier run, the latest failed');
		expect(cards('Exports')[0]).toContain('entry queue');
		expect(cards('Retries')[0]).toContain('entry pulled');
		expect(page).toContain('<h2>Completed</h2><i class="tally">1</i>');
		for (const title of ['Library', 'Several', 'Exports', 'Retries'])
			expect(table.split('<tr ').filter((r) => r.includes(title))).toHaveLength(1);
		expect(table.split('<tr ').find((r) => r.includes('Library'))).toContain('2 earlier runs');
		const done = overview.split('<section id="completed">')[1] ?? '';
		expect(done).toContain('Retries');
		expect(done).not.toContain('Library');
	});

	it('shows on a Waiting card why its Ticket was handed back and the Next step, after the events moved on', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.happened({
			kind: 'needs-info',
			feature: '3',
			ticket: '8',
			why: 'it asked 1 question, round 1',
			next: ticketStep(DEFAULT_SIGNAL_NAMES, 'answer')
		});
		file.happened({
			kind: 'needs-info',
			feature: '3',
			ticket: null,
			why: '1 Ticket waits',
			next: featureAfterRunStep(DEFAULT_SIGNAL_NAMES, { waiting: true, red: false })
		});
		for (let t = 1; t <= 10; t++)
			file.happened({ kind: 'built', feature: '9', ticket: String(100 + t) });
		file.refreshed([], {
			items: [
				{
					kind: 'feature',
					id: '3',
					title: 'Webhooks',
					why: 'needs info',
					ticketCounts: { total: 3, closed: 0 }
				},
				{ kind: 'ticket', id: '8', title: 'Facets', why: 'needs info', feature: '3' }
			],
			trackerCannotList: false
		});
		await open();
		const page = (await get('/')).text;
		const [board = '', rest = ''] = page.split('<div class="table">');
		const card = board.split('<article').find((a) => a.includes('Webhooks')) ?? '';
		expect(card).toContain('<p>1 Ticket waits</p>');
		expect(card).toContain('0 of 3 built now');
		expect(card).toContain(
			'Facets <small>needs info</small> <span class="reason">it asked 1 question, round 1</span>'
		);
		expect(card).toContain(
			'<p>Next step</p><ol><li>Answer in a comment here.</li><li>On this Ticket, remove <code>needs-info</code> and add <code>ready-for-agent</code>.</li>'
		);
		// the Feature's own Next step comes after the Tickets it speaks of
		const deal = card.indexOf('<li>Deal with the waiting Tickets above');
		expect(deal).toBeGreaterThan(card.indexOf('Facets'));
		const row = rest.split('<tr ').find((r) => r.includes('Webhooks')) ?? '';
		expect(row).toContain('needs info: 1 Ticket waits');
	});

	it('says so when no reason is recorded for a waiting Feature', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.refreshed([], {
			items: [{ kind: 'feature', id: '3', title: 'Webhooks', why: 'needs a person' }],
			trackerCannotList: false
		});
		await open();
		const board = (await get('/')).text.split('<div class="table">')[0] ?? '';
		const card = board.split('<article').find((a) => a.includes('Webhooks')) ?? '';
		expect(card).toContain('no reason recorded; see its comments on the Tracker');
		expect(card).not.toContain('Next step');
	});

	it('lists at most ten Completed, newest first, and says when the run is off', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		for (let n = 1; n <= 12; n++)
			file.happened({ kind: 'failed', feature: String(100 + n), why: 'check red' });
		await open();
		let page = (await get('/')).text;
		const board = page.split('<div class="board">')[1]?.split('<div class="table">')[0] ?? '';
		expect(board.match(/class="entry failed"/g)).toHaveLength(10);
		expect(board.indexOf('#112')).toBeLessThan(board.indexOf('#111'));
		alive = false;
		page = (await get('/')).text;
		expect(page).toContain('not known while nightjar is off');
	});

	it('explains the eggs in a legend, and shows no tallies while nightjar is off', async () => {
		status().doing({ kind: 'idle', nextPollAt: at.toISOString() });
		await open();
		alive = false;
		const page = (await get('/')).text;
		for (const word of ['built', 'building', 'needs a person', 'waiting'])
			expect(page).toContain(`</i>${word}</span>`);
		expect(page).toContain('<section class="mat" data-state="queue"');
		for (const state of ['waiting', 'building', 'queue'])
			expect(page).toMatch(
				new RegExp(`data-state="${state}"><div class="tab"><h2>[^<]*</h2></div>`)
			);
	});

	it('shows a waiting Ticket on the card of the Feature it belongs to, not the one that ended last', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.happened({
			kind: 'pull',
			feature: '4',
			title: 'Later one',
			url: 'https://example.test/pull/4'
		});
		file.refreshed([], {
			items: [
				{ kind: 'feature', id: '3', title: 'Webhooks', why: 'needs a person' },
				{ kind: 'ticket', id: '8', title: 'Facets', why: 'needs info', feature: '3' }
			],
			trackerCannotList: false
		});
		await open();
		const board = (await get('/')).text.split('<div class="table">')[0] ?? '';
		const cards = board.split('<article').slice(1);
		const webhooks = cards.find((a) => a.includes('Webhooks')) ?? '';
		expect(webhooks).toContain('Facets <small>needs info</small>');
		expect(cards.filter((a) => a.includes('Facets'))).toHaveLength(1);
	});

	it("gives a waiting Ticket's own card the needs info its Feature carries", async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.refreshed([], {
			items: [{ kind: 'ticket', id: '8', title: 'Facets', why: 'needs a person', feature: '3' }],
			trackerCannotList: true
		});
		await open();
		const board = (await get('/')).text.split('<div class="table">')[0] ?? '';
		const card = board.split('<article').find((a) => a.includes('Facets')) ?? '';
		expect(card).toContain('#3');
		expect(card).toContain('needs info');
	});

	it('shows how long a Completed Feature took, and nothing for one with no start', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		const start = new Date(at.getTime() - 14 * 60_000).toISOString();
		file.happened({
			kind: 'pull',
			feature: '31',
			url: 'https://example.test/pull/31',
			startedAt: start
		});
		file.happened({ kind: 'failed', feature: '32', why: 'check red', startedAt: start });
		file.happened({ kind: 'failed', feature: '33', why: 'check red' });
		await open();
		const page = (await get('/')).text;
		const board = page.split('<div class="board">')[1]?.split('<div class="table">')[0] ?? '';
		expect(board.match(/<time class="took">14m 00s<\/time>/g)).toHaveLength(2);
		expect(board.match(/class="took"/g)).toHaveLength(2);
	});

	it('labels the ledger columns, inlines the banner under a CSP that allows only data images, and says when a count is unknown', async () => {
		await open();
		const got = await fetch(`http://127.0.0.1:${String(ui?.port)}/`);
		const page = await got.text();
		expect(got.headers.get('content-security-policy')).toContain('img-src data:');
		expect(page).toContain('.banner { background-image: url(data:image/webp;base64,');
		expect(page).toContain('<span>Tickets</span><span>State</span>');
		expect(page).not.toContain('>?<');
	});

	it('shows the build in flight in a detail panel: its Tickets in order, clock, cost and the Session tail', async () => {
		status().doing({
			kind: 'building',
			feature: '272',
			title: 'Custom views',
			ticket: '2',
			step: 'build',
			round: 1,
			rounds: 3,
			session: null,
			startedAt: at.toISOString(),
			tickets: [
				{ id: '1', title: 'Schema', state: 'built' },
				{ id: '2', title: 'Views list', state: 'building' }
			]
		});
		await open();
		const page = (await get('/')).text;
		const panel = page.split('<aside class="detail"')[1]?.split('</aside>')[0] ?? '';
		expect(page).toContain('<div class="cols has-detail">');
		expect(panel).toContain('Building now');
		expect(panel).toContain('Custom views');
		expect(panel).toContain('<li class="built">');
		expect(panel).toContain('<li class="building">');
		expect(panel).toContain('data-since');
	});

	it('puts the detail panel Tickets in their order, with the clock, cost and Session tail', async () => {
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/r',
			feature: '272',
			ticket: '1',
			branch: 'b',
			step: 'build',
			session: 'sess',
			costUsd: 1.18,
			outcome: 'built'
		});
		mkdirSync(join(root, '.factory', 'logs'), { recursive: true });
		writeFileSync(
			join(root, '.factory', 'logs', 'sess.jsonl'),
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'text', text: 'tail line <one>' }] }
			})
		);
		status().doing({
			kind: 'building',
			feature: '272',
			title: 'Custom views',
			ticket: '2',
			step: 'build',
			round: 1,
			rounds: 3,
			session: 'sess',
			startedAt: at.toISOString(),
			tickets: [
				{ id: '1', title: 'First', state: 'built' },
				{ id: '2', title: 'Second', state: 'building' },
				{ id: '3', title: 'Third', state: 'waiting', why: 'waits for #2' }
			]
		});
		await open();
		const page = (await get('/')).text;
		const panel = page.split('<aside class="detail"')[1]?.split('</aside>')[0] ?? '';
		expect(panel).toContain('Ticket 2 of 3, build, round 1 of 3');
		expect(panel.indexOf('First')).toBeLessThan(panel.indexOf('Second'));
		expect(panel.indexOf('Second')).toBeLessThan(panel.indexOf('Third'));
		expect(panel).toContain('waits for #2');
		expect(panel).toContain('$1.18');
		expect(panel).toContain('<pre>');
		expect(panel).toContain('tail line &#60;one&#62;');
	});

	it('reads the Board with Waiting on you first, then Building, Queue, Shelf and Completed', async () => {
		status().doing({ kind: 'idle', nextPollAt: at.toISOString() });
		await open();
		const page = (await get('/')).text;
		const order = ['waiting', 'building', 'queue', 'shelf', 'completed'].map((state) =>
			page.indexOf(`<section class="mat" data-state="${state}"`)
		);
		expect(order.every((i) => i >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it('shows at most 16 eggs for a Feature, and how many more there are', async () => {
		status().doing({
			kind: 'building',
			feature: '5',
			title: 'Big',
			ticket: '1',
			step: 'build',
			round: null,
			rounds: null,
			session: null,
			startedAt: at.toISOString(),
			tickets: Array.from({ length: 20 }, (_, i) => ({
				id: String(i + 1),
				title: `T${String(i + 1)}`,
				state: i === 0 ? ('building' as const) : ('waiting' as const)
			}))
		});
		await open();
		const page = (await get('/')).text;
		const row = page.split('<span class="eggs"')[1]?.split('</span>')[0] ?? '';
		expect(row.match(/class="slot"/g)).toHaveLength(16);
		expect(row).toContain('<small>+4</small>');
	});

	it('shows no detail panel while nothing is being built', async () => {
		status().doing({ kind: 'idle', nextPollAt: at.toISOString() });
		await open();
		const page = (await get('/')).text;
		expect(page).not.toContain('<aside class="detail"');
		expect(page).not.toContain('<div class="cols has-detail">');
	});

	it('records a session duration in the ledger, and still reads a line without one', () => {
		const old = {
			at: at.toISOString(),
			repo: 'o/app',
			feature: '1',
			ticket: null,
			branch: 'b',
			step: 'build',
			session: 's',
			costUsd: 1,
			outcome: 'built'
		};
		mkdirSync(join(root, '.factory'), { recursive: true });
		record(ledgerFile(), { ...old, step: 'build', durationMs: 90_000 });
		writeFileSync(ledgerFile(), `${JSON.stringify(old)}\n`, { flag: 'a' });
		const lines = readFileSync(ledgerFile(), 'utf8').trim().split('\n');
		expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ durationMs: 90_000 });
		expect(JSON.parse(lines[1] ?? '{}')).not.toHaveProperty('durationMs');
	});

	it('remembers the view in local storage and applies it again', async () => {
		await open();
		const script = (await get('/')).text.split('<script>')[1]?.split('</script>')[0] ?? '';
		const store: Record<string, string> = { 'nightjar-view': 'overview' };
		const panels = { dataset: {} as Record<string, string> };
		const button = { dataset: { view: 'board' } as Record<string, string>, onclick: () => {} };
		runInNewContext(script, {
			matchMedia: noMedia,
			document: { getElementById: () => panels, querySelectorAll: () => [button] },
			localStorage: {
				getItem: (k: string) => store[k] ?? null,
				setItem: (k: string, v: string) => (store[k] = v)
			},
			EventSource: function EventSource() {
				return {};
			},
			setInterval: () => 0
		});
		expect(panels.dataset['view']).toBe('overview');
		button.onclick();
		expect([panels.dataset['view'], store['nightjar-view']]).toEqual(['board', 'board']);
	});
});

describe('nightjar ui Table', () => {
	const seed = () => {
		const file = status(true);
		const start = new Date(at.getTime() - 10 * 60_000).toISOString();
		file.happened({
			kind: 'pull',
			feature: '31',
			title: 'Done one',
			url: 'https://example.test/pull/31',
			startedAt: new Date(at.getTime() - 5 * 60_000).toISOString()
		});
		file.happened({
			kind: 'failed',
			feature: '32',
			title: 'Broke',
			why: 'check red',
			startedAt: start
		});
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.refreshed(
			[
				{ id: '9', title: 'Exports' },
				{ id: '10', title: 'Alerts' }
			],
			{
				items: [{ kind: 'feature', id: '3', title: 'Webhooks', why: 'needs a person' }],
				trackerCannotList: false
			}
		);
	};
	const tableHtml = async () =>
		(await get('/')).text.split('<div class="table">')[1]?.split('<div class="overview">')[0] ?? '';

	it('adds Table to the toggle and renders a row per Feature with six columns, in state then Queue order', async () => {
		seed();
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('data-view="table">Table</button>');
		const table = await tableHtml();
		for (const name of ['Id', 'Title', 'State', 'Time', 'Cost', 'Outcome'])
			expect(table).toContain(`data-sort="${name.toLowerCase()}">${name}</button>`);
		const ids = [...table.matchAll(/<tr data-state="(\w+)"[^>]*data-id="(\d+)"/g)].map(
			(m) => `${m[1] ?? ''}:${m[2] ?? ''}`
		);
		expect(ids).toEqual(['queue:9', 'queue:10', 'waiting:3', 'completed:32', 'completed:31']);
		expect(table).toContain('href="https://example.test/pull/31"');
		expect(table).toContain('>draft pull request</a>');
		expect(table).toContain('failed: check red');
	});

	// the page script run against rows read from the served table
	const sandbox = (html: string, store: Record<string, string>) => {
		interface Row {
			dataset: Record<string, string>;
			hidden: boolean;
		}
		const rows: Row[] = [...html.matchAll(/<tr ([^>]*)>/g)].map((m) => {
			const dataset: Record<string, string> = {};
			for (const a of (m[1] ?? '').matchAll(/data-([\w-]+)="([^"]*)"/g))
				dataset[(a[1] ?? '').replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = a[2] ?? '';
			return { dataset, hidden: false };
		});
		const body = {
			list: rows,
			appendChild(r: Row) {
				body.list = body.list.filter((x) => x !== r);
				body.list.push(r);
			}
		};
		const panels: { dataset: Record<string, string>; onclick?: (e: unknown) => void } = {
			dataset: {}
		};
		const item = (attr: string, k: string): { dataset: Record<string, string> } => ({
			dataset: { [attr]: k }
		});
		const sorts = ['id', 'title', 'state', 'time', 'cost', 'outcome'].map((k) => item('sort', k));
		const chips = ['queue', 'building', 'waiting', 'completed'].map((k) => item('chip', k));
		let focused: string | null = null;
		const picks = ['any', 'completed', 'failed', 'waiting'].map((k) => ({
			...item('pick', k),
			focus: () => {
				focused = k;
			}
		}));
		// the line under the filters that says how many rows show
		const shown = { textContent: '' };
		let message: ((e: { data: string }) => void) | undefined;
		const code = html.split('<script>')[1]?.split('</script>')[0] ?? '';
		const withRows = rows.map((r) => Object.assign(r, { parentNode: body }));
		return {
			rows: () => body.list,
			sorts,
			chips,
			picks,
			shown,
			focused: () => focused,
			panels,
			load: () => {
				runInNewContext(code, {
					matchMedia: noMedia,
					document: {
						getElementById: () => panels,
						querySelectorAll: (sel: string) =>
							sel === 'tr[data-state]'
								? [...body.list]
								: sel === 'button[data-sort]'
									? sorts
									: sel === 'button[data-chip]'
										? chips
										: sel === 'button[data-pick]'
											? picks
											: sel === '[data-shown]'
												? [shown]
												: []
					},
					localStorage: {
						getItem: (k: string) => store[k] ?? null,
						setItem: (k: string, v: string) => (store[k] = v)
					},
					EventSource: function EventSource() {
						return {
							set onmessage(f: (e: { data: string }) => void) {
								message = f;
							}
						};
					},
					setInterval: () => 0
				});
			},
			click: (item: { dataset: Record<string, string> }, attr: 'sort' | 'chip' | 'pick' | 'goto') =>
				panels.onclick?.({
					target: { closest: (sel: string) => (sel === `[data-${attr}]` ? item : null) }
				}),
			refresh: () => message?.({ data: JSON.stringify('') }),
			withRows
		};
	};
	const order = (s: ReturnType<typeof sandbox>) => s.rows().map((r) => r.dataset['id']);

	it('sorts by a header, reverses on a second click, filters by chip, and keeps both over a refresh and a reload', async () => {
		seed();
		await open();
		const page = (await get('/')).text;
		const store: Record<string, string> = {};
		const s = sandbox(page, store);
		s.load();
		expect(order(s)).toEqual(['9', '10', '3', '32', '31']);
		const idSort = s.sorts[0] as (typeof s.sorts)[number];
		s.click(idSort, 'sort');
		expect(order(s)).toEqual(['3', '9', '10', '31', '32']);
		s.click(idSort, 'sort');
		expect(order(s)).toEqual(['32', '31', '10', '9', '3']);
		const time = s.sorts[3] as (typeof s.sorts)[number];
		s.click(time, 'sort');
		// 31 took 5 minutes, 32 took 10; rows with no time come last
		expect(order(s).slice(0, 2)).toEqual(['31', '32']);
		s.click(s.chips[3] as (typeof s.chips)[number], 'chip');
		expect(s.rows().map((r) => r.hidden)).toEqual([false, false, true, true, true]);
		expect(order(s).filter((_, i) => !s.rows()[i]?.hidden)).toEqual(['31', '32']);

		// a live refresh swaps the panels' content but the arrangement stays
		s.refresh();
		expect(order(s).slice(0, 2)).toEqual(['31', '32']);
		expect(s.rows().filter((r) => r.hidden)).toHaveLength(3);

		// a reload reads it back from local storage
		const again = sandbox(page, store);
		again.load();
		expect(order(again).slice(0, 2)).toEqual(['31', '32']);
		expect(again.rows().filter((r) => r.hidden)).toHaveLength(3);
		expect(again.chips.map((c) => c.dataset['on'])).toEqual(['false', 'false', 'false', 'true']);
	});

	it('offers the outcomes as a labelled group of buttons beside the state chips', async () => {
		seed();
		await open();
		const table = await tableHtml();
		const after = table.split('<div class="chips" role="group" aria-label="Outcome">')[1] ?? '';
		const group = after.split('</div>')[0] ?? '';
		const buttons = [...group.matchAll(/data-pick="(\w+)">([^<]*)</g)];
		expect(buttons.map((m) => `${m[1] ?? ''}:${m[2] ?? ''}`)).toEqual([
			'any:Any',
			'completed:Completed',
			'failed:Failed',
			'waiting:Needs a person'
		]);
		expect(group).toContain('class="chips-label">Outcome</span>');
		// they are buttons, so a keyboard reaches and presses them
		expect(group).not.toContain('<a ');
	});

	it('filters by outcome, says how many rows show, and keeps the filter over a refresh and a reload', async () => {
		seed();
		await open();
		const page = (await get('/')).text;
		const store: Record<string, string> = {};
		const s = sandbox(page, store);
		s.load();
		const visible = (x: ReturnType<typeof sandbox>) => x.rows().filter((r) => !r.hidden);
		const ids = (x: ReturnType<typeof sandbox>) => visible(x).map((r) => r.dataset['id']);
		const pick = (i: number) => s.picks[i] as (typeof s.picks)[number];
		const [any, done, failed, waiting] = [pick(0), pick(1), pick(2), pick(3)];
		expect(ids(s)).toEqual(['9', '10', '3', '32', '31']);
		expect(s.shown.textContent).toBe('');
		expect(s.picks.map((p) => p.dataset['on'])).toEqual(['true', 'false', 'false', 'false']);

		s.click(failed, 'pick');
		expect(ids(s)).toEqual(['32']);
		expect(s.shown.textContent).toBe('Showing 1 of 5 Features');
		expect(s.picks.map((p) => p.dataset['on'])).toEqual(['false', 'false', 'true', 'false']);
		// a Feature that failed is not a completed one
		s.click(done, 'pick');
		expect(ids(s)).toEqual(['31']);
		s.click(waiting, 'pick');
		expect(ids(s)).toEqual(['3']);
		s.click(any, 'pick');
		expect(ids(s)).toEqual(['9', '10', '3', '32', '31']);
		expect(s.shown.textContent).toBe('');

		// it works with the state chips and the sort
		s.click(failed, 'pick');
		s.click(s.chips[3] as (typeof s.chips)[number], 'chip');
		expect(ids(s)).toEqual(['32']);
		s.click(s.chips[3] as (typeof s.chips)[number], 'chip');
		s.click(s.sorts[0] as (typeof s.sorts)[number], 'sort');
		expect(ids(s)).toEqual(['32']);

		// a live refresh keeps it
		s.refresh();
		expect(ids(s)).toEqual(['32']);

		// a reload reads it back from local storage
		const again = sandbox(page, store);
		again.load();
		expect(ids(again)).toEqual(['32']);
		expect(again.picks.map((p) => p.dataset['on'])).toEqual(['false', 'false', 'true', 'false']);
	});

	it('ignores a stored outcome it does not know, and one stored by an older page', async () => {
		seed();
		await open();
		const page = (await get('/')).text;
		for (const kept of [
			{ states: [], outcome: 'bogus' },
			{ states: [], sort: 'id' }
		]) {
			const s = sandbox(page, { 'nightjar-table': JSON.stringify(kept) });
			s.load();
			expect(s.rows().filter((r) => r.hidden)).toHaveLength(0);
			expect(s.picks.map((p) => p.dataset['on'])).toEqual(['true', 'false', 'false', 'false']);
		}
	});

	it('takes a count on the Overview to the Table filtered to it, and focuses the filter', async () => {
		seed();
		await open();
		const page = (await get('/')).text;
		const store: Record<string, string> = { 'nightjar-view': 'overview' };
		const s = sandbox(page, store);
		s.load();
		s.click({ dataset: { goto: 'failed' } }, 'goto');
		expect(s.panels.dataset['view']).toBe('table');
		expect(store['nightjar-view']).toBe('table');
		expect(JSON.parse(store['nightjar-table'] ?? '{}')).toMatchObject({ outcome: 'failed' });
		const shown = s.rows().filter((r) => !r.hidden);
		expect(shown.map((r) => r.dataset['id'])).toEqual(['32']);
		expect(s.focused()).toBe('failed');
	});
});

describe('nightjar ui last seven days', () => {
	// `at` is Fri 30 Oct 2026, 09:00 local: the week runs from Sat 24 Oct 00:00
	const day = (d: number, hour = 12) => new Date(2026, 9, d, hour, 0);
	const statusAt = (when: Date) =>
		new StatusFile({
			path: join(root, '.factory', 'status.json'),
			spend: fileSpend(ledgerFile()),
			now: () => when,
			pid: 42,
			dailyUsd: 8
		});
	const spent = (when: Date, costUsd: number, feature = '1') =>
		record(ledgerFile(), {
			at: when.toISOString(),
			repo: 'o/r',
			feature,
			ticket: '2',
			branch: 'b',
			step: 'build',
			session: 's',
			costUsd,
			outcome: 'built'
		});
	const panels = () => renderPanels(root, readFactory(root, { alive: () => true, now: () => at }));
	const weekOf = () => panels().split('<section id="week">')[1]?.split('</section>')[0] ?? '';

	it('opens the Overview with the four counts of the week, leaving out the lines outside it', () => {
		// the evening before the week, and a Session of each day in it
		spent(day(23, 23), 100);
		spent(day(24, 0), 1);
		spent(day(25), 2);
		spent(day(30, 8), 4.5);
		statusAt(day(20)).happened({ kind: 'pull', feature: '33', url: 'https://x.test/33' });
		statusAt(day(25)).happened({ kind: 'pull', feature: '31', url: 'https://x.test/31' });
		statusAt(day(28)).happened({ kind: 'failed', feature: '32', why: 'check red' });
		statusAt(day(29)).happened({
			kind: 'needs-info',
			feature: '40',
			ticket: '41',
			why: 'needs info'
		});
		statusAt(at).doing({ kind: 'idle', nextPollAt: at.toISOString() });

		const overview = panels().split('<div class="overview">')[1] ?? '';
		// it comes first, before the Current build
		expect(overview.startsWith('<section id="week"><h2>Last seven days</h2>')).toBe(true);
		const week = weekOf();
		expect(week).toContain('<b>1</b> Feature completed');
		expect(week).toContain('<b>1</b> Feature failed');
		// the failed Feature was handed back too, and counts as failed alone
		expect(week).toContain('<b>1</b> Feature handed to a person');
		expect(week).toContain('<li><b>$7.50</b> spent</li>');
	});

	it('links each count of Features to the Table, and the dollars to nothing', () => {
		const week = weekOf();
		for (const pick of ['completed', 'failed', 'waiting'])
			expect(week).toMatch(new RegExp(`<a class="count" href="#panels" data-goto="${pick}">`));
		expect(week.match(/<a /g)).toHaveLength(3);
		// each link says what the Table will show, which is not the week's alone
		expect(week).toContain('<span class="sr">, show every completed Feature in the Table</span>');
		expect(week).toContain('<span class="sr">, show every failed Feature in the Table</span>');
		expect(week).toContain(
			'<span class="sr">, show the Features that need a person now in the Table</span>'
		);
		expect(week).toContain(
			'which shows every Feature the Table holds with that outcome, of any day'
		);
		// words carry the meaning, not a colour
		expect(week).toContain('Features completed');
		expect(week).toContain('Features failed');
	});

	it('shows zeros, not an error, for a repo with no ledger and no status', () => {
		const week = weekOf();
		expect(week).toContain('<b>0</b> Features completed');
		expect(week).toContain('<b>0</b> Features failed');
		expect(week).toContain('<b>0</b> Features handed to a person');
		expect(week).toContain('<li><b>$0.00</b> spent</li>');
	});

	it('counts an old ledger line with no models, and skips a ledger line that does not parse', () => {
		mkdirSync(join(root, '.factory'), { recursive: true });
		writeFileSync(ledgerFile(), 'not json\n');
		spent(day(29), 3);
		expect(weekOf()).toContain('<li><b>$3.00</b> spent</li>');
	});

	it('draws the week in a hand-made view that has none as zeros', () => {
		const { week: _week, ...view } = readFactory(root, { alive: () => true, now: () => at });
		expect(renderPanels(root, view)).toContain('<li><b>$0.00</b> spent</li>');
	});

	it('has a style for the counts and the filter in both themes, and keeps their targets large on a phone', async () => {
		await open();
		const page = (await get('/')).text;
		expect(page).toMatch(/@media \(pointer: coarse\) \{[^}]*a\.count[^}]*min-height: 44px/);
		expect(PAPER_STYLE).toMatch(/@media \(pointer: coarse\) \{[^}]*a\.count[^}]*min-height: 44px/);
		for (const style of [page, PAPER_STYLE]) {
			expect(style).toContain('.week {');
			expect(style).toContain('.filters {');
		}
	});
});

describe('nightjar ui page, more', () => {
	it('shows a paused run with why', async () => {
		status().doing({ kind: 'paused', why: 'daily limit reached', until: null });
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('<span class="state">paused</span>');
		expect(page).toContain('daily limit reached');
	});

	describe('review fixes', () => {
		const building = () => {
			const file = status();
			file.doing({
				kind: 'building',
				feature: '5',
				title: 'Search',
				ticket: '7',
				step: 'build',
				round: 1,
				rounds: 3,
				session: null,
				startedAt: at.toISOString(),
				tickets: [
					{ id: '7', title: 'Query', state: 'building' },
					{ id: '8', title: 'Facets', state: 'waiting', why: 'needs info' }
				]
			});
			file.happened({ kind: 'failed', feature: '9', title: 'Retry', why: 'it broke' });
			return file;
		};

		it('labels a failed Feature Failed in the Table, not Completed', async () => {
			building();
			await open();
			const page = (await get('/')).text;
			const row =
				page
					.split('<tr ')
					.slice(1)
					.find((r) => r.includes('Retry')) ?? '';
			expect(row).toContain('<td>Failed</td>');
		});

		it('names a waiting Ticket needs a person, not waiting', async () => {
			building();
			await open();
			const page = (await get('/')).text;
			expect(page).toContain('<small>needs a person: needs info</small>');
			expect(page).not.toContain('<small>waiting');
		});

		it('keys an unbuilt Ticket with the socket the board draws', async () => {
			building();
			await open();
			const page = (await get('/')).text;
			expect(page).toContain('<i class="slot"></i>waiting');
			expect(page).not.toContain('<i class="egg waiting"></i>waiting');
		});

		it('lets a keyboard scroll the Table and names the banner once', async () => {
			building();
			await open();
			const page = (await get('/')).text;
			expect(page).toContain(
				'<div class="scroll" tabindex="0" role="region" aria-label="Feature table">'
			);
			expect(page).toContain('<div class="banner" aria-hidden="true">');
			expect(page).toContain("'aria-pressed'");
			expect(page).not.toContain("'aria-current'");
		});
	});
});

describe('nightjar ui audit fixes', () => {
	// a theme's own stylesheet; each theme is a whole sheet, so the rules every page needs are checked in each
	const css = async (theme: Theme = 'nightjar') => {
		await open();
		const page = (await get('/')).text;
		const style =
			page.split(new RegExp(`<style data-theme="${theme}"[^>]*>`))[1]?.split('</style>')[0] ?? '';
		return { page, style };
	};
	const rule = (style: string, selector: string) =>
		style.split('\n').find((l) => l.startsWith(`${selector} {`)) ?? '';

	it('has a status region outside the panels that stays out of sight', async () => {
		for (const theme of THEMES) {
			const { page, style } = await css(theme);
			expect(page).toContain('<p id="live" class="sr" role="status"></p>');
			expect(page.indexOf('id="live"')).toBeLessThan(page.indexOf('<main id="panels"'));
			expect(style.split('\n').find((l) => l.startsWith('.sr,'))).toContain('clip');
		}
	});

	it('announces only when the waiting or failed count rises', async () => {
		await open();
		const script = (await get('/')).text.split('<script>')[1]?.split('</script>')[0] ?? '';
		const live = { textContent: '' };
		const panels = { dataset: {} as Record<string, string>, innerHTML: '' };
		const counts = { waiting: 1, failed: 0 };
		let message: ((e: { data: string }) => void) | undefined;
		const frames: Array<() => void> = [];
		const flush = () => frames.splice(0).forEach((f) => f());
		runInNewContext(script, {
			matchMedia: noMedia,
			requestAnimationFrame: (f: () => void) => frames.push(f),
			document: {
				getElementById: (id: string) => (id === 'live' ? live : panels),
				querySelectorAll: (sel: string) =>
					Array.from({
						length:
							sel === 'tr[data-state="waiting"]'
								? counts.waiting
								: sel === 'tr[data-failed]'
									? counts.failed
									: 0
					})
			},
			localStorage: { getItem: () => null, setItem: () => {} },
			EventSource: function EventSource() {
				return {
					set onmessage(f: (e: { data: string }) => void) {
						message = f;
					}
				};
			},
			setInterval: () => 0
		});
		const push = () => {
			message?.({ data: JSON.stringify('') });
			flush();
		};
		expect(live.textContent).toBe('');
		push();
		expect(live.textContent).toBe('');
		counts.waiting = 2;
		push();
		expect(live.textContent).toBe('2 waiting on a person');
		counts.waiting = 1;
		push();
		expect(live.textContent).toBe('2 waiting on a person');
		counts.failed = 1;
		push();
		expect(live.textContent).toBe('1 failed');
		// a repeat of the same text is cleared first, so assistive tech reads it again
		counts.failed = 0;
		push();
		counts.failed = 1;
		message?.({ data: JSON.stringify('') });
		expect(live.textContent).toBe('');
		flush();
		expect(live.textContent).toBe('1 failed');
	});

	const BUTTONS = [
		'th button',
		'#views button',
		'#themes button',
		'.chips button',
		'button.copy',
		'a.act',
		'a.open'
	];
	it.each(THEMES)(
		'gives sort buttons, view and theme tabs, chips, copy buttons and links a 24px hit area, 44px on touch (%s)',
		async (theme) => {
			const { style } = await css(theme);
			for (const s of BUTTONS) expect(rule(style, s), s).toContain('min-height: 24px');
			const coarse = style.split('@media (pointer: coarse)')[1] ?? '';
			for (const s of BUTTONS) expect(coarse, s).toContain(s);
			expect(coarse).toContain('min-height: 44px');
		}
	);
	it("gives the Session page's folded results the same hit area in the Nightjar stylesheet", async () => {
		const { style } = await css('nightjar');
		expect(rule(style, '.log summary')).toContain('min-height: 24px');
		const coarse = style.split('@media (pointer: coarse)')[1] ?? '';
		expect(coarse).toContain('.log summary');
	});

	it('keeps every font size on the documented ramp, none under 0.75rem', async () => {
		const { style } = await css();
		const sizes = [...style.matchAll(/font(?:-size)?:[^;}]*?(\d*\.?\d+)(rem|px)/g)].map((m) =>
			m[2] === 'px' ? `${m[1] ?? ''}px` : Number(m[1])
		);
		const ramp = [0.75, 0.85, 1, 1.05, 1.2, 1.6, '15px'];
		expect(sizes.filter((s) => !ramp.includes(s))).toEqual([]);
	});

	it("keeps Paper's font sizes on its 11.5px to 16px ramp", async () => {
		const { style } = await css('paper');
		const sizes = [...style.matchAll(/font(?:-size)?:[^;}]*?(\d*\.?\d+)px/g)].map((m) => m[1]);
		expect(sizes.length).toBeGreaterThan(0);
		const ramp = ['11.5', '12', '12.5', '13', '13.5', '14', '16'];
		expect(sizes.filter((s) => !ramp.includes(s ?? ''))).toEqual([]);
	});

	it.each(THEMES)(
		'collapses entries beside the detail panel only between 1261px and 1400px (%s)',
		async (theme) => {
			const { style } = await css(theme);
			expect(style).not.toContain('@media (max-width: 1400px)');
			const block =
				style.split('@media (min-width: 1261px) and (max-width: 1400px)')[1]?.split('\n}')[0] ?? '';
			expect(block).toContain('.cols.has-detail .entry');
			expect(block).toContain('.cols.has-detail .head');
		}
	);

	it('keeps the inner scroll of the log, detail panel and Table across a live swap', async () => {
		await open();
		const script = (await get('/')).text.split('<script>')[1]?.split('</script>')[0] ?? '';
		const el = (scrollTop: number, scrollLeft = 0) => ({ scrollTop, scrollLeft });
		let found: Record<string, Array<{ scrollTop: number; scrollLeft: number }>> = {
			pre: [el(90)],
			'.scroll': [el(0, 40)],
			'.detail': [el(12)]
		};
		const live = { textContent: '' };
		const panels = {
			dataset: {} as Record<string, string>,
			set innerHTML(_: string) {
				found = { pre: [el(0)], '.scroll': [el(0)], '.detail': [el(0)] };
			}
		};
		let message: ((e: { data: string }) => void) | undefined;
		runInNewContext(script, {
			matchMedia: noMedia,
			requestAnimationFrame: (f: () => void) => f(),
			document: {
				getElementById: (id: string) => (id === 'live' ? live : panels),
				querySelectorAll: (sel: string) => found[sel] ?? []
			},
			localStorage: { getItem: () => null, setItem: () => {} },
			EventSource: function EventSource() {
				return {
					set onmessage(f: (e: { data: string }) => void) {
						message = f;
					}
				};
			},
			setInterval: () => 0
		});
		message?.({ data: JSON.stringify('') });
		expect(found.pre?.[0]?.scrollTop).toBe(90);
		expect(found['.scroll']?.[0]?.scrollLeft).toBe(40);
		expect(found['.detail']?.[0]?.scrollTop).toBe(12);
	});

	it('draws the egg wings square, on DESIGN.md radius scale', async () => {
		const { style } = await css();
		expect(rule(style, '.egg.need::before, .egg.need::after')).not.toContain('border-radius');
	});

	it.each(THEMES)('draws colours from tokens: no literals outside :root (%s)', async (theme) => {
		const { style } = await css(theme);
		const rest = style
			.split('\n')
			.filter((l) => !l.startsWith(':root'))
			.join('\n');
		expect(rest).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(rest).not.toContain('rgba(');
	});

	it('keeps the Nightjar tokens for its sockets, mats and shading', async () => {
		const { style } = await css('nightjar');
		for (const t of ['--socket-dash', '--socket-border', '--panel-overlay', '--shade-soft'])
			expect(style).toContain(`${t}:`);
	});

	it('sets the body background once', async () => {
		const { style } = await css();
		const body = rule(style, 'body');
		expect(body).not.toContain('background:');
		expect(body.match(/linear-gradient/g)).toHaveLength(2);
	});

	it('has no hover tooltip or shadow: the help button opens the panel', async () => {
		const { style, page } = await css();
		expect(style).not.toContain('data-tip');
		expect(style).not.toContain('tip-shadow');
		expect(style).not.toContain('box-shadow: 0 6px');
		expect(page).not.toContain('data-tip');
	});

	it.each(THEMES)(
		'lets the whole page scroll on a short or narrow viewport (%s)',
		async (theme) => {
			const { style } = await css(theme);
			const block =
				style.split('@media (max-height: 480px), (max-width: 400px)')[1]?.split('\n}')[0] ?? '';
			expect(block).toContain('height: auto');
			expect(block).toContain('overflow: visible');
		}
	);

	it('puts focus back on a copy button or link after a live swap', async () => {
		await open();
		const script = (await get('/')).text.split('<script>')[1]?.split('</script>')[0] ?? '';
		const focus = vi.fn();
		const copy = { dataset: { copy: 'npm test "x"' }, focus, getAttribute: () => null };
		const link = {
			dataset: {},
			tagName: 'A',
			focus: vi.fn(),
			getAttribute: () => 'https://x.test/1'
		};
		for (const [was, found, sel] of [
			[copy, [copy], '[data-copy]'],
			[link, [link], 'a[href]']
		] as const) {
			const doc = {
				activeElement: was,
				getElementById: () => ({ dataset: {}, innerHTML: '', textContent: '' }),
				querySelectorAll: (s: string) => (s === sel ? found : [])
			};
			let message: ((e: { data: string }) => void) | undefined;
			runInNewContext(script, {
				matchMedia: noMedia,
				requestAnimationFrame: (f: () => void) => f(),
				document: doc,
				localStorage: { getItem: () => null, setItem: () => {} },
				EventSource: function EventSource() {
					return {
						set onmessage(f: (e: { data: string }) => void) {
							message = f;
						}
					};
				},
				setInterval: () => 0
			});
			message?.({ data: JSON.stringify('') });
		}
		expect(focus).toHaveBeenCalledOnce();
		expect(link.focus).toHaveBeenCalledOnce();
	});

	it('takes the page region out of the tab order when the whole page scrolls', async () => {
		await open();
		const script = (await get('/')).text.split('<script>')[1]?.split('</script>')[0] ?? '';
		const scroller = { tabIndex: 0, dataset: {}, innerHTML: '', textContent: '' };
		let change: (() => void) | undefined;
		const media = {
			matches: true,
			addEventListener: (_: string, f: () => void) => {
				change = f;
			}
		};
		runInNewContext(script, {
			matchMedia: () => media,
			requestAnimationFrame: (f: () => void) => f(),
			document: {
				activeElement: null,
				getElementById: (id: string) =>
					id === 'scroll' ? scroller : { dataset: {}, innerHTML: '', textContent: '' },
				querySelectorAll: () => []
			},
			localStorage: { getItem: () => null, setItem: () => {} },
			EventSource: function EventSource() {
				return {};
			},
			setInterval: () => 0
		});
		expect(scroller.tabIndex).toBe(-1);
		media.matches = false;
		change?.();
		expect(scroller.tabIndex).toBe(0);
	});

	it('puts focus back on the link that had it when several share an href', async () => {
		await open();
		const script = (await get('/')).text.split('<script>')[1]?.split('</script>')[0] ?? '';
		const link = () => ({
			dataset: {},
			tagName: 'A',
			focus: vi.fn(),
			getAttribute: () => 'https://x.test/1'
		});
		const [first, second] = [link(), link()];
		let message: ((e: { data: string }) => void) | undefined;
		runInNewContext(script, {
			matchMedia: noMedia,
			requestAnimationFrame: (f: () => void) => f(),
			document: {
				activeElement: second,
				getElementById: () => ({ dataset: {}, innerHTML: '', textContent: '' }),
				querySelectorAll: (s: string) => (s === 'a[href]' ? [first, second] : [])
			},
			localStorage: { getItem: () => null, setItem: () => {} },
			EventSource: function EventSource() {
				return {
					set onmessage(f: (e: { data: string }) => void) {
						message = f;
					}
				};
			},
			setInterval: () => 0
		});
		message?.({ data: JSON.stringify('') });
		expect(second.focus).toHaveBeenCalledOnce();
		expect(first.focus).not.toHaveBeenCalled();
	});

	it('offers a skip link to the panels', async () => {
		const { page } = await css();
		expect(page).toContain('<a class="skip" href="#panels">Skip to Features</a>');
		expect(page).toContain('<main id="panels" data-view="board" tabindex="-1">');
	});
});

describe('nightjar ui guidance and links', () => {
	const config = {
		tracker: { type: 'github', repo: 'o/app' },
		codeHost: { type: 'github', repo: 'o/app' },
		check: 'npm test',
		allowedCommands: ['npm test']
	};
	const waitingOnInfo = () => {
		writeFileSync(join(root, 'factory.json'), JSON.stringify(config));
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.refreshed([], {
			items: [{ kind: 'feature', id: '268', title: 'Webhook retries', why: 'needs info' }],
			trackerCannotList: false
		});
	};

	it('links a Feature and its pull request to the Tracker and the Code host', async () => {
		writeFileSync(join(root, 'factory.json'), JSON.stringify(config));
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.happened({ kind: 'pull', feature: '259', url: 'https://github.com/o/app/pull/9' });
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('href="https://github.com/o/app/issues/259"');
		expect(page).toContain('href="https://github.com/o/app/pull/9"');
		expect(page).toContain('href="https://github.com/o/app/pulls"');
		expect(page).toContain('target="_blank"');
	});

	it('tells the person what to do about needs info, with the repo’s Signal names and a link', async () => {
		waitingOnInfo();
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('aria-controls="help-268"');
		expect(page).toContain('<code>needs-info</code>');
		expect(page).toContain('<code>ready-for-agent</code>');
		expect(page).toContain('<code>factory-go</code>');
		expect(page).toContain('aria-label="Answer #268 on GitHub"');
	});

	it('keeps the run state and the view switcher outside the scrolling content', async () => {
		await open();
		const page = (await get('/')).text;
		expect(page).toMatch(/<div id="top">.*<header>.*<\/div>\s*<div id="scroll"/s);
	});

	it('says how to start Nightjar when it is off', async () => {
		await open();
		expect((await get('/')).text).toContain('data-copy="nightjar --watch"');
	});
});

describe('nightjar ui Session page', () => {
	const logs = () => join(root, '.factory', 'logs');
	const transcript = (id: string, lines: unknown[]) => {
		mkdirSync(logs(), { recursive: true });
		writeFileSync(join(logs(), `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
	};
	const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });
	const result = (content: unknown) => ({
		type: 'user',
		message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] }
	});
	const logged = (over: Partial<Parameters<typeof record>[1]> = {}) =>
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/app',
			feature: '261',
			ticket: '266',
			branch: 'factory/261-logbook',
			step: 'fix',
			session: 'sess-1',
			costUsd: 1.5,
			outcome: 'round 2',
			durationMs: 125_000,
			...over
		});
	const panelOf = (page: string) =>
		(page.split('<aside class="detail"')[1] ?? '').split('</aside>')[0] ?? '';

	// the page as drawn for the Session, without a server
	const rendered = (id: string) => {
		const found = readSession(root, id);
		if (found === null) throw new Error(`no transcript for ${id}`);
		return sessionPage(found);
	};

	it('shows the whole transcript: the text, a line per tool call and each result folded', () => {
		transcript('sess-1', [
			assistant({ type: 'text', text: 'Reading <the> spec' }),
			assistant({ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }),
			result('3 passed\n1 failed'),
			assistant({ type: 'tool_use', name: 'Edit', input: { file_path: 'src/x.ts' } })
		]);
		const page = rendered('sess-1');
		expect(page).toContain('<li class="text"><p>Reading &#60;the&#62; spec</p></li>');
		expect(page).toContain('<li class="tool">Bash: npm test</li>');
		expect(page).toContain('<li class="tool">Edit: src/x.ts</li>');
		// the result is a closed <details> the keyboard opens: nothing says `open`
		expect(page).toContain(
			'<details><summary>Result <small>2 lines</small></summary><pre>3 passed\n1 failed</pre></details>'
		);
		const where = (s: string) => page.indexOf(s);
		expect(where('Reading')).toBeLessThan(where('Bash: npm test'));
		expect(where('Bash: npm test')).toBeLessThan(where('3 passed'));
		expect(where('3 passed')).toBeLessThan(where('Edit: src/x.ts'));
	});

	it('says what the ledger has of the Session: Feature, Ticket, kind, outcome, cost and duration', () => {
		transcript('sess-1', [assistant({ type: 'text', text: 'hello' })]);
		logged();
		logged({ ticket: null, step: 'review', outcome: 'approve', costUsd: 0.25 });
		// another Session's line is not this one's
		logged({ session: 'other', outcome: 'outcome of another Session' });
		const page = rendered('sess-1');
		expect(page).toContain('<dt>Feature</dt><dd>#261</dd>');
		expect(page).toContain('<dt>Ticket</dt><dd>#266</dd>');
		expect(page).toContain('<dt>Kind</dt><dd>fix round</dd>');
		expect(page).toContain('<dt>Outcome</dt><dd>round 2</dd>');
		expect(page).toContain('<dt>Cost</dt><dd>$1.50</dd>');
		expect(page).toContain('<dt>Duration</dt><dd>2m 05s</dd>');
		// a Session that resumed another has a line each; one over the whole Feature has no Ticket
		expect(page).toContain('<dt>Ticket</dt><dd>the whole Feature</dd>');
		expect(page).toContain('<dt>Kind</dt><dd>Review</dd>');
		expect(page).not.toContain('outcome of another Session');
	});

	it('leaves out the Duration of a ledger line written before durations were', () => {
		transcript('sess-1', [assistant({ type: 'text', text: 'hello' })]);
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/app',
			feature: '261',
			ticket: '266',
			branch: 'factory/261-logbook',
			step: 'build',
			session: 'sess-1',
			costUsd: 1,
			outcome: 'built'
		});
		const page = rendered('sess-1');
		expect(page).toContain('<dt>Outcome</dt><dd>built</dd>');
		expect(page).not.toContain('<dt>Duration</dt>');
	});

	it('shows the transcript with a note when the ledger has no line for the Session', () => {
		transcript('sess-1', [assistant({ type: 'text', text: 'hello' })]);
		const page = rendered('sess-1');
		expect(page).toContain('The ledger has no line for this Session.');
		expect(page).toContain('hello');
	});

	it('says plainly when a transcript has nothing to show', () => {
		transcript('sess-1', [{ type: 'system' }]);
		expect(rendered('sess-1')).toContain('The transcript has nothing to show yet.');
	});

	it('links a Feature and a Ticket to the Tracker when the page knows it', () => {
		transcript('sess-1', [assistant({ type: 'text', text: 'hello' })]);
		logged();
		const found = readSession(root, 'sess-1');
		const page = sessionPage(found as NonNullable<typeof found>, {
			...NO_LINKS,
			tracker: 'GitHub',
			issue: (id) => `https://github.com/o/app/issues/${id}`
		});
		expect(page).toContain('href="https://github.com/o/app/issues/261"');
		expect(page).toContain('href="https://github.com/o/app/issues/266"');
	});

	it('gives an id with no transcript a plain not-found page, even when the ledger knows it', async () => {
		logged();
		await open();
		const got = await get('/sessions/sess-1');
		expect(got.status).toBe(404);
		expect(got.text).toContain('Session not found');
		expect(got.text).toContain('There is no transcript for this Session on this machine.');
		expect(got.text).toContain('href="/"');
	});

	it('refuses an id that is not a Session id, and reads nothing outside the logs', async () => {
		mkdirSync(join(root, '.factory'), { recursive: true });
		writeFileSync(join(root, '.factory', 'secret.jsonl'), 'x');
		await open();
		for (const id of ['', 'a.b', 'a%2Fb', '..%2Fsecret', 'a%2e', 'a b', 'a'.repeat(129)]) {
			const got = await get(`/sessions/${id}`);
			expect(got.status, id).toBe(400);
			expect(got.text, id).not.toContain('<html');
		}
	});

	it('takes only GET and HEAD, as every page does', async () => {
		transcript('sess-1', [assistant({ type: 'text', text: 'hello' })]);
		await open();
		expect((await get('/sessions/sess-1', 'POST')).status).toBe(405);
		expect((await get('/sessions/sess-1', 'HEAD')).status).toBe(200);
	});

	it('works by keyboard and at phone width: a skip link, a way back, a scroll region and a wrapping grid', async () => {
		transcript('sess-1', [assistant({ type: 'text', text: 'hello' })]);
		await open();
		const page = (await get('/sessions/sess-1')).text;
		expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
		expect(page).toContain('<a class="skip" href="#panels">');
		expect(page).toContain('<a class="open" href="/">Back to the Board</a>');
		expect(page).toContain('id="scroll" role="region" aria-label="Session" tabindex="0"');
		expect(page).toContain('<main id="panels" tabindex="-1">');
		expect(page).toContain('grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr))');
	});

	it('links the Building now tail to the Session being built, and to none when it has no Session yet', async () => {
		const building = (session: string | null) =>
			status().doing({
				kind: 'building',
				feature: '261',
				title: 'Logbook',
				ticket: '266',
				step: 'build',
				round: null,
				rounds: null,
				session,
				startedAt: at.toISOString(),
				tickets: [{ id: '266', title: 'Session page', state: 'building' }]
			});
		transcript('sess-1', [assistant({ type: 'text', text: 'hello' })]);
		building('sess-1');
		await open();
		expect(panelOf((await get('/')).text)).toContain(
			'<a class="open" href="/sessions/sess-1">Open this Session</a>'
		);
		building(null);
		const panel = panelOf((await get('/')).text);
		expect(panel).toContain('Building now');
		expect(panel).not.toContain('/sessions/');
	});

	it("links back to the Feature's Logbook", () => {
		transcript('sess-1', [assistant({ type: 'text', text: 'hello' })]);
		logged();
		expect(rendered('sess-1')).toContain(
			'<a class="open" href="/features/261">Open the Logbook of #261</a>'
		);
	});
});

describe('nightjar ui Logbook page', () => {
	const minute = (m: number) => new Date(at.getTime() + m * 60_000).toISOString();
	const note = (m: number, entry: Decision & Place, feature = '261') =>
		fileLogbook(root).write({ at: minute(m), feature, ...entry });
	const ran = (m: number, over: Partial<Parameters<typeof record>[1]> = {}) =>
		record(ledgerFile(), {
			at: minute(m),
			repo: 'o/app',
			feature: '261',
			ticket: '266',
			branch: 'factory/261-logbook',
			step: 'build',
			session: 'sess-1',
			costUsd: 1.5,
			outcome: 'built',
			durationMs: 125_000,
			...over
		});
	const transcript = (id: string, lines: unknown[]) => {
		mkdirSync(join(root, '.factory', 'logs'), { recursive: true });
		writeFileSync(
			join(root, '.factory', 'logs', `${id}.jsonl`),
			lines.map((l) => JSON.stringify(l)).join('\n')
		);
	};
	const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });

	// a build of one Ticket: a red check and its fix round, the Review asking for changes, and the draft pull request
	const seed = () => {
		transcript('sess-1', [
			assistant({ type: 'text', text: 'Reading the spec' }),
			assistant({ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }),
			{
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 't', content: '3 passed' }] }
			}
		]);
		note(0, { kind: 'buildStarted', by: 'go', branch: 'factory/261-logbook', workflow: null });
		note(0, { kind: 'ticketStarted', ticket: '266' });
		ran(4);
		note(4, {
			kind: 'checkRed',
			report: 'lint: 1 problem\nsrc/x.ts:1 <unused>',
			round: 1,
			rounds: 3,
			ticket: '266',
			session: 'sess-1'
		});
		ran(6, { step: 'fix', outcome: 'round 1', costUsd: 0.5 });
		note(7, { kind: 'ticketBuilt', commit: 'abc1234', ticket: '266' });
		ran(9, { ticket: null, step: 'review', session: 'sess-2', outcome: 'changes', costUsd: 1 });
		note(9, {
			kind: 'review',
			verdict: 'changes',
			summary: 'Needs a test.',
			issues: [{ file: 'src/x.ts', line: 3, problem: 'no test' }],
			session: 'sess-2'
		});
		note(10, { kind: 'pullOpened', url: 'https://example.test/pull/9', created: true });
	};
	const drawn = (feature = '261') =>
		logbookPage(readLogbook(root, feature), readFactory(root, { alive: () => alive }));

	it('shows every Session and each decision between them, in order', () => {
		seed();
		const page = drawn();
		expect(page).toContain('<h1>Logbook</h1> <span>#261</span>');
		expect(page).toContain('<p class="meta">3 Sessions, $3.00</p>');
		const where = (s: string) => {
			const i = page.indexOf(s);
			expect(i, s).toBeGreaterThan(-1);
			return i;
		};
		const order = [
			'Build started by the Go on factory/261-logbook',
			'Ticket #266: Ticket started',
			'Open the build Session',
			'Check red, so fix round 1 of 3',
			'Open the fix round Session',
			'Ticket built in commit abc1234',
			'Open the Review Session',
			'Review asked for changes: Needs a test.',
			'Draft pull request opened'
		].map(where);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(page).not.toContain('did not record');
	});

	it('gives each Session its kind, Ticket, outcome, cost and duration, its summary folded, and a link to its page', () => {
		seed();
		const page = drawn();
		const build = page.split('<li class="session">')[1] ?? '';
		expect(build).toContain('<a class="open" href="/sessions/sess-1">Open the build Session</a>');
		const fields = [
			'<dt>Kind</dt><dd>build</dd>',
			'<dt>Ticket</dt><dd>#266</dd>',
			'<dt>Outcome</dt><dd>built</dd>',
			'<dt>Cost</dt><dd>$1.50</dd>',
			'<dt>Duration</dt><dd>2m 05s</dd>'
		];
		for (const field of fields) expect(build).toContain(field);
		// the summary rendering: the text and a line per tool call, no result, and closed until opened
		expect(build).toContain(
			'<details data-key="i2"><summary>Summary <small>2 lines</small></summary><ol class="log" aria-label="Transcript"><li class="text"><p>Reading the spec</p></li><li class="tool">Bash: npm test</li></ol></details>'
		);
		expect(build).not.toContain('3 passed');
		expect(page).not.toMatch(/<details[^>]*\sopen/);
		// a Session over the whole Feature has no Ticket, and one with no transcript here says so
		expect(page).toContain('<dt>Ticket</dt><dd>the whole Feature</dd>');
		expect(page).toContain('No transcript of this Session on this machine.');
	});

	it("folds a red check's gate report, and the Review's issues, under the line that says what happened", () => {
		seed();
		const page = drawn();
		expect(page).toContain(
			'Ticket #266: Check red, so fix round 1 of 3</p><details data-key="i3"><summary>Gate report <small>2 lines</small></summary><pre>lint: 1 problem\nsrc/x.ts:1 &#60;unused&#62;</pre></details>'
		);
		expect(page).toContain(
			'<summary>1 issue <small>1 line</small></summary><pre>src/x.ts:3 no test</pre>'
		);
		expect(page).toContain(
			'<a class="ext" href="https://example.test/pull/9" target="_blank" rel="noreferrer noopener">https://example.test/pull/9</a>'
		);
	});

	it("names a Signal and a hand-over by the repo's own Signal names", () => {
		note(0, { kind: 'signal', signal: 'working', on: true });
		note(1, { kind: 'handed', to: 'needsInfo', why: 'the check stayed red', ticket: '266' });
		const page = drawn();
		expect(page).toContain(`Signal <code>${DEFAULT_SIGNAL_NAMES.working}</code> put on`);
		expect(page).toContain(`<li class="decision handed"><p><time datetime="${minute(1)}">`);
		expect(page).toContain(
			`Ticket #266: Handed to a person with <code>${DEFAULT_SIGNAL_NAMES.needsInfo}</code>: the check stayed red`
		);
	});

	it('shows a Feature built before the Logbook as its Sessions, with a quiet note', () => {
		ran(4);
		const page = drawn();
		expect(page).toContain('Open the build Session');
		expect(page).toContain(
			`<p class="empty note">Builds before the Logbook did not record Nightjar's decisions, so this shows the Feature's Sessions only.</p>`
		);
	});

	it('says so when nothing is recorded for the Feature yet', async () => {
		await open();
		const got = await get('/features/275');
		expect(got.status).toBe(200);
		expect(got.text).toContain('Nightjar has recorded nothing for this Feature yet.');
		expect(got.text).not.toContain('did not record');
	});

	it('names the Feature by the title the page knows, and shows its build in flight at the end', () => {
		seed();
		status().doing({
			kind: 'building',
			feature: '261',
			title: 'Logbook <page>',
			ticket: '267',
			step: 'build',
			round: null,
			rounds: null,
			session: 'sess-3',
			startedAt: at.toISOString(),
			tickets: [{ id: '267', title: 'Logbook page', state: 'building' }]
		});
		const page = drawn();
		expect(page).toContain('<span>#261 Logbook &#60;page&#62;</span>');
		const live = page.split('<li class="live">')[1] ?? '';
		expect(live).toContain('<span class="label">Building now</span> Ticket 1 of 1, build');
		expect(live).toContain('<a class="open" href="/sessions/sess-3">Open this Session</a>');
		expect(page.indexOf('Draft pull request opened')).toBeLessThan(page.indexOf('class="live"'));
		// another Feature's build is not this one's
		expect(drawn('262')).not.toContain('class="live"');
	});

	it('links every Mat card, Table row and Building now to its Feature’s Logbook', async () => {
		const file = status();
		file.happened({ kind: 'failed', feature: '132', title: 'Retries', why: 'check red' });
		file.refreshed([{ id: '275', title: 'Saved filters' }], {
			items: [{ kind: 'feature', id: '262', title: 'Audit log', why: 'needs info' }],
			trackerCannotList: false
		});
		file.doing({
			kind: 'building',
			feature: '261',
			title: 'Logbook',
			ticket: '267',
			step: 'build',
			round: null,
			rounds: null,
			session: null,
			startedAt: at.toISOString(),
			tickets: [{ id: '267', title: 'Logbook page', state: 'building' }]
		});
		await open();
		const page = (await get('/')).text;
		const [board = '', rest = ''] = page.split('<div class="table">');
		const table = rest.split('<div class="overview">')[0] ?? '';
		const link = (id: string) =>
			`<a class="open book-link" href="/features/${id}" aria-label="Logbook of #${id}">Logbook</a>`;
		const cards = board.split('<article').slice(1);
		expect(cards).toHaveLength(4);
		for (const id of ['132', '275', '262', '261']) {
			expect(cards.find((c) => c.includes(`#${id}`))).toContain(link(id));
			expect(table.split('<tr ').find((r) => r.includes(`data-id="${id}"`))).toContain(link(id));
		}
		const panel = (board.split('<aside class="detail"')[1] ?? '').split('</aside>')[0] ?? '';
		expect(panel).toContain('<a class="open" href="/features/261">Open its Logbook</a>');
	});

	it('lists every Logbook on the Overview, newest first, so a Feature off the Board stays reachable', async () => {
		await open();
		expect((await get('/')).text).toContain(
			'<section id="logbooks"><h2>All Logbooks</h2><p class="empty">no Logbook yet</p></section>'
		);
		ran(-60, { feature: '268', session: 's-268' });
		ran(-30, { feature: '132', session: 's-132' });
		ran(-20, { feature: '132', session: 's-132b', costUsd: 2 });
		// a Logbook with no Session yet, as intake leaves one
		note(-10, { kind: 'madeBySource', source: 'sentry' }, '270');
		status().happened({ kind: 'failed', feature: '270', title: 'Saved <filters>', why: 'x' });
		const overview = (await get('/')).text.split('<section id="logbooks">')[1] ?? '';
		const list = overview.split('</section>')[0] ?? '';
		const ids = [...list.matchAll(/href="\/features\/(\d+)"/g)].map((m) => m[1]);
		expect(ids).toEqual(['270', '132', '268']);
		expect(list).toContain('href="/features/270">#270 Saved &#60;filters&#62;</a>');
		expect(list).toContain('<small>2 Sessions, $3.50, last <time');
		expect(list).toContain('<small>0 Sessions, $0.00, last <time');
	});

	it('follows the build live: the page opens its own events, which bring the Logbook again on each change', async () => {
		seed();
		await open();
		const page = (await get('/features/261')).text;
		expect(page).toContain('<main id="panels" tabindex="-1" data-events="/features/261/events">');
		expect(page).toContain('new EventSource(panels.dataset.events)');
		const events = await fetch(`http://127.0.0.1:${String(ui?.port)}/features/261/events`);
		expect(events.headers.get('content-type')).toBe('text/event-stream');
		const reader = (events.body as ReadableStream<Uint8Array>).getReader();
		const first = await nextPanels(reader);
		expect(first).toContain('Build started by the Go');
		expect(first).not.toContain('<html');
		note(11, { kind: 'paused', why: 'the day is over $8.00' });
		expect(await nextPanels(reader)).toContain('Paused: the day is over $8.00');
		await reader.cancel();
	});

	it('keeps a fold the person opened open, and their focus, when the Logbook comes again', async () => {
		seed();
		await open();
		const page = (await get('/features/261')).text;
		const code = page.split('<script>')[2]?.split('</script>')[0] ?? '';
		expect(code).toContain('EventSource');
		let state: 'before' | 'after' = 'before';
		let swapped = '';
		let url = '';
		let message: ((e: { data: string }) => void) | undefined;
		let focused = false;
		const opened = { dataset: { key: 'i3' }, open: true };
		const summary = {
			focus: () => {
				focused = true;
			}
		};
		const again = { dataset: { key: 'i3' }, open: false, querySelector: () => summary };
		const other = { dataset: { key: 'i2' }, open: false, querySelector: () => null };
		const panels = {
			dataset: { events: '/features/261/events' },
			set innerHTML(html: string) {
				swapped = html;
				state = 'after';
			},
			querySelectorAll: (sel: string) => {
				if (sel === 'details[open]') return state === 'before' ? [opened] : [];
				if (sel === 'details[data-key]') return state === 'after' ? [other, again] : [opened];
				return [];
			}
		};
		runInNewContext(code, {
			document: {
				getElementById: () => panels,
				activeElement: { tagName: 'SUMMARY', parentNode: opened }
			},
			EventSource: function EventSource(to: string) {
				url = to;
				return {
					set onmessage(f: (e: { data: string }) => void) {
						message = f;
					}
				};
			}
		});
		expect(url).toBe('/features/261/events');
		message?.({ data: JSON.stringify('<p>again</p>') });
		expect(swapped).toBe('<p>again</p>');
		expect(again.open).toBe(true);
		expect(other.open).toBe(false);
		expect(focused).toBe(true);
	});

	it('reads only a Feature id, and only through its Logbook file', async () => {
		note(0, { kind: 'paused', why: 'slash in its id' }, 'a/b');
		ran(0);
		await open();
		expect((await get('/features/a%2Fb')).text).toContain('Paused: slash in its id');
		for (const id of ['%ZZ', 'a%0Ab', 'a'.repeat(129)]) {
			const got = await get(`/features/${id}`);
			expect(got.status, id).toBe(400);
			expect(got.text, id).not.toContain('<html');
		}
		expect((await get('/features/261/x')).status).toBe(404);
		expect((await get('/features/261/events/x')).status).toBe(404);
		// a path out of the Logbook folder is only a Feature id with nothing recorded
		const out = await get('/features/..%2Fruns');
		expect(out.text).toContain('Nightjar has recorded nothing for this Feature yet.');
		expect((await get('/features/261', 'POST')).status).toBe(405);
		expect((await get('/features/261', 'HEAD')).status).toBe(200);
	});

	it('works by keyboard and at phone width: a skip link, a way back, a scroll region, folds and 44px targets on touch', async () => {
		seed();
		await open();
		const page = (await get('/features/261')).text;
		expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
		expect(page).toContain('<a class="skip" href="#panels">Skip to the Logbook</a>');
		expect(page).toContain('<a class="open" href="/">Back to the Board</a>');
		expect(page).toContain('id="scroll" role="region" aria-label="Logbook" tabindex="0"');
		expect(page).toContain('<ol class="book" aria-label="Logbook">');
		expect(page).toMatch(/@media \(pointer: coarse\) \{[^}]*\.book summary[^}]*min-height: 44px/);
	});
});

describe('nightjar ui cost by stage and model', () => {
	const models = [
		{
			model: 'model-a',
			inputTokens: 1200,
			outputTokens: 40,
			cacheReadTokens: 2_500_000,
			cacheWriteTokens: 300,
			costUsd: 2.5
		}
	];
	const line = (
		feature: string,
		step: 'build' | 'fix' | 'review',
		session: string,
		costUsd: number,
		withModels = false
	) =>
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/r',
			feature,
			ticket: step === 'review' ? null : '2',
			branch: 'b',
			step,
			session,
			costUsd,
			outcome: 'built',
			...(withModels ? { models } : {})
		});
	const panels = () => renderPanels(root, readFactory(root, { alive: () => true, now: () => at }));
	const cardOf = (page: string, id: string) => {
		const cards = (page.split('<div class="table">')[0] ?? '').split('<article');
		return cards.find((a) => a.includes(`#${id}`)) ?? '';
	};
	const rowOf = (page: string, id: string) => {
		const rows = (page.split('<div class="table">')[1] ?? '').split('<tr ');
		return rows.find((r) => r.includes(`data-id="${id}"`)) ?? '';
	};
	const pulled = (id: string) => {
		status().happened({ kind: 'pull', feature: id, url: `https://x.test/${id}` });
	};

	it("opens a Completed Feature's cost into its stages and its models, on its card and its row, folded", () => {
		line('7', 'build', 'a', 3, true);
		line('7', 'fix', 'a', 1, true);
		line('7', 'review', 'r', 0.5, true);
		pulled('7');
		const page = panels();

		const card = cardOf(page, '7');
		expect(card).toContain('<details class="cost" data-key="card:7:');
		expect(card).toContain('<summary data-fold="card:7:');
		expect(card).toContain('>Cost by stage and model</summary>');
		expect(card).not.toMatch(/<details[^>]* open/);
		expect(card).toContain('<dt>Tickets</dt><dd>$4.00 <small>2 Sessions</small></dd>');
		expect(card).toContain('<dt>Review</dt><dd>$0.50 <small>1 Session</small></dd>');
		expect(card.indexOf('<dt>Tickets</dt>')).toBeLessThan(card.indexOf('<dt>Review</dt>'));
		expect(card).toContain(
			'<dt>model-a</dt><dd>$7.50 <small>tokens: 3.6k in, 120 out, 7.5M cache read, 900 cache write</small></dd>'
		);
		expect(card).not.toContain('Models were not recorded');

		const row = rowOf(page, '7');
		expect(row).toContain('data-cost="4.5"');
		expect(row).toContain('<td class="cost"><details class="cost" data-key="row:7:');
		expect(row).toContain('$4.50<span class="sr">, cost by stage and model</span></summary>');
		expect(row).toContain('<dt>Tickets</dt><dd>$4.00');
	});

	it('shows a Feature whose ledger lines are all older its stages, and a quiet note that models were not recorded', () => {
		line('7', 'build', 'a', 3);
		line('7', 'review', 'r', 0.5);
		pulled('7');
		const card = cardOf(panels(), '7');
		expect(card).toContain('<dt>Tickets</dt><dd>$3.00');
		expect(card).toContain('<dt>Review</dt><dd>$0.50');
		expect(card).toContain('<p class="empty">Models were not recorded for these Sessions.</p>');
	});

	it('says what the Sessions that recorded no model cost, beside the models', () => {
		line('7', 'build', 'a', 3);
		line('7', 'review', 'r', 0.5, true);
		pulled('7');
		const card = cardOf(panels(), '7');
		expect(card).toContain('<dt>model-a</dt>');
		expect(card).toContain('Models were not recorded for 1 Session, $3.00.');
	});

	it('shows the dollars alone for a build with no ledger line', () => {
		pulled('7');
		const page = panels();
		expect(cardOf(page, '7')).not.toContain('<details class="cost"');
		expect(rowOf(page, '7')).toContain('<td class="cost">$0.00</td>');
	});

	it('opens the cost of the build in flight in Building now and in its row', () => {
		line('272', 'build', 'a', 1.18, true);
		status().doing({
			kind: 'building',
			feature: '272',
			title: 'Custom views',
			ticket: '2',
			step: 'build',
			round: 1,
			rounds: 3,
			session: null,
			startedAt: at.toISOString()
		});
		const page = panels();
		const panel = page.split('<aside class="detail"')[1]?.split('</aside>')[0] ?? '';
		expect(panel).toContain('<details class="cost" data-key="now:272:');
		expect(panel).toContain('>Cost by stage and model</summary>');
		expect(panel).toContain('<dt>Tickets</dt><dd>$1.18 <small>1 Session</small></dd>');
		expect(panel).toContain('<dt>model-a</dt>');
		expect(rowOf(page, '272')).toContain('data-key="row:272:');
	});

	it('works by keyboard and at phone width: a fold kept open across a live swap, focus on its summary, 44px on touch', async () => {
		await open();
		const page = (await get('/')).text;
		expect(page).toMatch(/@media \(pointer: coarse\) \{[^}]*\.cost summary[^}]*min-height: 44px/);
		// at phone width a stage or model stacks its dollars under its name
		expect(page).toContain('\t.split dl div { grid-template-columns: 1fr; }');
		const script = page.split('<script>')[1]?.split('</script>')[0] ?? '';
		const summary = { dataset: { fold: 'card:7:x' }, focus: vi.fn(), getAttribute: () => null };
		const opened = { dataset: { key: 'card:7:x' }, open: true };
		const fresh = { dataset: { key: 'card:7:x' }, open: false };
		const other = { dataset: { key: 'row:7:x' }, open: false };
		let swapped = false;
		const element = {
			dataset: {},
			textContent: '',
			set innerHTML(_: string) {
				swapped = true;
			}
		};
		let message: ((e: { data: string }) => void) | undefined;
		runInNewContext(script, {
			matchMedia: noMedia,
			requestAnimationFrame: (f: () => void) => f(),
			document: {
				activeElement: summary,
				getElementById: () => element,
				querySelectorAll: (sel: string) => {
					if (sel === 'details[open][data-key]') return swapped ? [] : [opened];
					if (sel === 'details[data-key]') return swapped ? [fresh, other] : [opened];
					if (sel === '[data-fold]') return [summary];
					return [];
				}
			},
			localStorage: { getItem: () => null, setItem: () => {} },
			EventSource: function EventSource() {
				return {
					set onmessage(f: (e: { data: string }) => void) {
						message = f;
					}
				};
			},
			setInterval: () => 0
		});
		message?.({ data: JSON.stringify('') });
		expect(fresh.open).toBe(true);
		expect(other.open).toBe(false);
		expect(summary.focus).toHaveBeenCalledOnce();
	});
});

describe('nightjar ui Steps bar', () => {
	const line = (
		feature: string,
		step: 'build' | 'fix' | 'review' | 'reviewRound',
		session: string,
		outcome: string,
		failure?: 'passing' | 'lasting'
	) =>
		record(ledgerFile(), {
			at: at.toISOString(),
			repo: 'o/r',
			feature,
			ticket: step === 'build' || step === 'fix' ? '2' : null,
			branch: 'b',
			step,
			session,
			costUsd: 1,
			outcome,
			...(failure === undefined ? {} : { failure })
		});
	const panels = () => renderPanels(root, readFactory(root, { alive: () => true, now: () => at }));
	const boardOf = (page: string) => page.split('<div class="table">')[0] ?? '';
	const tableOf = (page: string) => page.split('<div class="table">')[1] ?? '';
	const cardOf = (page: string, id: string) =>
		boardOf(page)
			.split('<article')
			.find((a) => a.includes(`#${id}`)) ?? '';
	const rowOf = (page: string, id: string) =>
		tableOf(page)
			.split('<tr ')
			.find((r) => r.includes(`data-id="${id}"`)) ?? '';
	const segment = (state: string, text: string) =>
		`<li class="seg ${state}" title="${text}"><span class="sr">${text}</span></li>`;
	const pulled = (id: string) =>
		status().happened({ kind: 'pull', feature: id, url: `https://x.test/${id}` });

	it('shows a hard build on its card and its row: a segment per stage, in order, each named in words and a tooltip', () => {
		line('7', 'build', 'a', 'failed: overloaded', 'passing');
		line('7', 'build', 'b', 'built');
		line('7', 'fix', 'b', 'round 1');
		line('7', 'review', 'r1', 'changes');
		line('7', 'reviewRound', 'rr', 'fixed');
		line('7', 'review', 'r2', 'approve');
		pulled('7');
		const page = panels();
		const bar = [
			'<ol class="stepsbar" aria-label="Steps bar of this build">',
			segment('retried', 'Tickets: passed after a retry or a round, 3 Sessions, $3.00'),
			segment('notNeeded', 'Steps: not needed, no Session'),
			segment('retried', 'Review: passed after a retry or a round, 2 Sessions, $2.00'),
			segment('passed', 'Review rounds: passed, 1 Session, $1.00'),
			segment('notNeeded', 'Pull checks: not needed, no Session'),
			segment('notNeeded', 'Feedback: not needed, no Session'),
			'</ol>'
		].join('');
		expect(cardOf(page, '7')).toContain(`<div class="eggcell">`);
		expect(cardOf(page, '7')).toContain(bar);
		expect(rowOf(page, '7')).toMatch(/<td class="progress">.*<ol class="stepsbar"/);
		expect(rowOf(page, '7')).toContain(bar);
	});

	it('shows a clean build passed first time, and a failed one failed where it failed and not reached after', () => {
		line('7', 'build', 'a', 'built');
		line('7', 'review', 'r', 'approve');
		pulled('7');
		line('8', 'build', 'c', 'failed: the check stayed red', 'lasting');
		status().happened({ kind: 'failed', feature: '8', why: 'check red' });
		const page = panels();
		expect(cardOf(page, '7')).toContain(segment('passed', 'Tickets: passed, 1 Session, $1.00'));
		expect(cardOf(page, '7')).toContain(segment('passed', 'Review: passed, 1 Session, $1.00'));
		expect(cardOf(page, '8')).toContain(segment('failed', 'Tickets: failed, 1 Session, $1.00'));
		expect(cardOf(page, '8')).toContain(segment('notReached', 'Review: not reached, no Session'));
	});

	it('marks the stage running now on the build in flight, and moves it as the build goes on', () => {
		const doing = (step: 'build' | 'review') =>
			status().doing({
				kind: 'building',
				feature: '272',
				title: 'Custom views',
				ticket: step === 'build' ? '2' : null,
				step,
				round: null,
				rounds: null,
				session: null,
				startedAt: at.toISOString()
			});
		doing('build');
		let page = panels();
		expect(cardOf(page, '272')).toContain(segment('running', 'Tickets: running, no Session'));
		expect(rowOf(page, '272')).toContain(segment('running', 'Tickets: running, no Session'));

		line('272', 'build', 'a', 'built');
		doing('review');
		page = panels();
		expect(cardOf(page, '272')).toContain(segment('passed', 'Tickets: passed, 1 Session, $1.00'));
		expect(cardOf(page, '272')).toContain(segment('running', 'Review: running, no Session'));
		expect(cardOf(page, '272')).toContain(
			segment('notReached', 'Review rounds: not reached, no Session')
		);
	});

	it('shows no Steps bar for a Feature with no Session in its build', () => {
		pulled('7');
		const page = panels();
		expect(cardOf(page, '7')).not.toContain('stepsbar');
		expect(rowOf(page, '7')).not.toContain('stepsbar');
	});

	it('sets a legend of every state once above the Table, and once on the Board', () => {
		line('7', 'build', 'a', 'built');
		pulled('7');
		const page = panels();
		const legend =
			'<p class="legend stepslegend"><span>Steps bar, one segment per stage:</span>' +
			'<span><i class="seg passed"></i>passed</span>' +
			'<span><i class="seg retried"></i>passed after a retry or a round</span>' +
			'<span><i class="seg failed"></i>failed</span>' +
			'<span><i class="seg running"></i>running</span>' +
			'<span><i class="seg notReached"></i>not reached</span>' +
			'<span><i class="seg notNeeded"></i>not needed</span></p>';
		expect(tableOf(page).startsWith(`${legend}<div class="filters">`)).toBe(true);
		expect(tableOf(page).split(legend)).toHaveLength(2);
		expect(boardOf(page).split(legend)).toHaveLength(2);
	});

	it.each(THEMES)(
		'draws each state from tokens, each with its own shape as well as its hue (%s)',
		(theme) => {
			const style =
				theme === 'paper'
					? PAPER_STYLE
					: (logbookPage(readLogbook(root, '7'), readFactory(root, { alive: () => true }))
							.split('<style>')[1]
							?.split('</style>')[0] ?? '');
			const rules = ['passed', 'retried', 'failed', 'running', 'notReached', 'notNeeded'].map(
				(s) => style.split('\n').find((l) => l.startsWith(`.seg.${s} {`)) ?? ''
			);
			for (const r of rules) {
				expect(r).toMatch(/var\(--/);
				expect(r).not.toMatch(/#[0-9a-f]{3,8}\b|rgba\(/i);
			}
			// the form differs, not the colour alone: solid, hatched, broken, half-filled, dashed, a thin line
			const forms = rules.map((r) => r.replace(/var\(--[a-z0-9-]+\)/g, 'C'));
			expect(new Set(forms).size).toBe(rules.length);
			expect(rules[1]).toContain('repeating-linear-gradient');
			expect(rules[4]).toContain('dashed');
		}
	);
});
