import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileSpend, record } from './ledger.js';
import { StatusFile } from './status.js';
import { startUi, type Ui } from './ui.js';

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

	it('shows a queued Feature with its Ticket count, 0 of N and its eggs', async () => {
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
		expect(card('Saved filters')).toContain('0 of 4 built');
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
		const queue = () => {
			const file = status();
			file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
			file.refreshed(
				[
					{ id: '275', title: 'Saved filters', ticketCounts: { total: 4, closed: 0 } },
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
		expect(card(board, 'Billing')).toContain('2 of 6 built');
		expect(card(board, 'Billing')).toContain('class="eggs"');
		expect(card(board, 'Unknown')).toContain('>count unknown<');
		expect(card(board, 'Unknown')).not.toContain('class="eggs"');
		// the ledger holds 3 built sessions, but the branch is 3 of the Feature's 4
		expect(card(board, 'Done one')).toContain('3 of 4 built');
		expect(card(board, 'Old one')).toContain('>count unknown<');
		expect(card(board, 'it broke')).toContain('1 of 5 built');
		expect(row('Billing')).toContain('2 of 6 built');
		expect(row('Done one')).toContain('3 of 4 built');
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

	it('changes nothing: only GET and HEAD are answered, and only / and /events', async () => {
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
	it('opens on a Board of four columns with a card per Feature, and keeps Overview', async () => {
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
		for (const name of ['Queue', 'Building', 'Waiting on you', 'Completed'])
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
		expect(card).toContain('1 of 3 built');
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

	it('reads the Board with Waiting on you first, then Building, Queue and Completed', async () => {
		status().doing({ kind: 'idle', nextPollAt: at.toISOString() });
		await open();
		const page = (await get('/')).text;
		const order = ['waiting', 'building', 'queue', 'completed'].map((state) =>
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
		let message: ((e: { data: string }) => void) | undefined;
		const code = html.split('<script>')[1]?.split('</script>')[0] ?? '';
		const withRows = rows.map((r) => Object.assign(r, { parentNode: body }));
		return {
			rows: () => body.list,
			sorts,
			chips,
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
			click: (item: { dataset: Record<string, string> }, attr: 'sort' | 'chip') =>
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
	const css = async () => {
		await open();
		const page = (await get('/')).text;
		return { page, style: page.split('<style>')[1]?.split('</style>')[0] ?? '' };
	};
	const rule = (style: string, selector: string) =>
		style.split('\n').find((l) => l.startsWith(`${selector} {`)) ?? '';

	it('has a status region outside the panels that stays out of sight', async () => {
		const { page, style } = await css();
		expect(page).toContain('<p id="live" class="sr" role="status"></p>');
		expect(page.indexOf('id="live"')).toBeLessThan(page.indexOf('<main id="panels"'));
		expect(style.split('\n').find((l) => l.startsWith('.sr,'))).toContain('clip');
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

	const BUTTONS = ['th button', '#views button', '.chips button', 'button.copy', 'a.act'];
	it('gives sort buttons, view tabs, chips, copy buttons and links a 24px hit area, 44px on touch', async () => {
		const { style } = await css();
		for (const s of BUTTONS) expect(rule(style, s), s).toContain('min-height: 24px');
		const coarse = style.split('@media (pointer: coarse)')[1] ?? '';
		for (const s of BUTTONS) expect(coarse, s).toContain(s);
		expect(coarse).toContain('min-height: 44px');
	});

	it('keeps every font size on the documented ramp, none under 0.75rem', async () => {
		const { style } = await css();
		const sizes = [...style.matchAll(/font(?:-size)?:[^;}]*?(\d*\.?\d+)(rem|px)/g)].map((m) =>
			m[2] === 'px' ? `${m[1] ?? ''}px` : Number(m[1])
		);
		const ramp = [0.75, 0.85, 1, 1.05, 1.2, 1.6, '15px'];
		expect(sizes.filter((s) => !ramp.includes(s))).toEqual([]);
	});

	it('collapses entries beside the detail panel only between 1261px and 1400px', async () => {
		const { style } = await css();
		expect(style).not.toContain('@media (max-width: 1400px)');
		const block =
			style.split('@media (min-width: 1261px) and (max-width: 1400px)')[1]?.split('\n}')[0] ?? '';
		expect(block).toContain('.cols.has-detail .entry');
		expect(block).toContain('.cols.has-detail .head');
	});

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

	it('draws colours from tokens: no literals outside :root', async () => {
		const { style } = await css();
		const rest = style
			.split('\n')
			.filter((l) => !l.startsWith(':root'))
			.join('\n');
		expect(rest).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(rest).not.toContain('rgba(');
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

	it('lets the whole page scroll on a short or narrow viewport', async () => {
		const { style } = await css();
		const block =
			style.split('@media (max-height: 480px), (max-width: 400px)')[1]?.split('\n}')[0] ?? '';
		expect(block).toContain('height: auto');
		expect(block).toContain('overflow: visible');
	});

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
