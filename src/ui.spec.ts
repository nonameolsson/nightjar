import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { record } from './ledger.js';
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
		ledger: ledgerFile(),
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

	it('shows a queued Feature with its Ticket count, 0 of N and a bar', async () => {
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
		expect(card('Saved filters')).toContain('class="bar"');
		expect(card('Exports')).toContain('? Tickets');
		expect(card('Exports')).not.toContain('class="bar"');
		expect(card('Reports')).not.toContain('Tickets');
		expect(card('Reports')).not.toContain('class="bar"');
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
		file.happened({ kind: 'pull', feature: '9', title: 'Done one', url });
		file.happened({ kind: 'failed', feature: '8', title: 'Retry', why: 'it broke' });
		await open();
		const page = (await get('/')).text;
		const [board = '', rest = ''] = page.split('<div class="table">');
		const table = rest.split('<div class="overview">')[0] ?? '';
		const card = (html: string, title: string) =>
			html.split('<article').find((a) => a.includes(title)) ?? '';
		const row = (title: string) => table.split('<tr ').find((a) => a.includes(title)) ?? '';
		expect(card(board, 'Billing')).toContain('2 of 6 built');
		expect(card(board, 'Billing')).toContain('class="bar"');
		expect(card(board, 'Unknown')).toContain('>?<');
		expect(card(board, 'Unknown')).not.toContain('class="bar"');
		expect(card(board, 'Done one')).toContain('3 of 3 built');
		expect(card(board, 'it broke')).toContain('1 of 5 built');
		expect(row('Billing')).toContain('2 of 6 built');
		expect(row('Done one')).toContain('3 of 3 built');
		expect(row('Unknown')).not.toContain('class="bar"');
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
		expect(page).toContain('<main id="panels" data-view="board">');
		for (const name of ['Queue', 'Building', 'Waiting on you', 'Completed'])
			expect(page).toContain(`<h2>${name}</h2>`);
		expect(page).toContain('Exports');
		expect(page).toContain('Ticket 2 of 3, build, round 1 of 3');
		expect(page).toContain('<li class="built">');
		expect(page).toContain('Webhooks');
		expect(page).toContain('Facets <small>needs info</small>');
		expect(page).toContain('<h2>Current build</h2>');
	});

	it('lists at most ten Completed, newest first, and says when the run is off', async () => {
		const file = status();
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		for (let n = 1; n <= 12; n++)
			file.happened({ kind: 'failed', feature: String(100 + n), why: 'check red' });
		await open();
		let page = (await get('/')).text;
		const board = page.split('<div class="board">')[1]?.split('<div class="table">')[0] ?? '';
		expect(board.match(/class="fcard failed"/g)).toHaveLength(10);
		expect(board.indexOf('#112')).toBeLessThan(board.indexOf('#111'));
		alive = false;
		page = (await get('/')).text;
		expect(page).toContain('not known while nightjar is off');
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
		expect(table).toContain('<a href="https://example.test/pull/31">draft pull request</a>');
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
		const script = (/<script>([\s\S]*)<\/script>/.exec(html) ?? [])[1];
		const withRows = rows.map((r) => Object.assign(r, { parentNode: body }));
		const code = script ?? '';
		return {
			rows: () => body.list,
			sorts,
			chips,
			panels,
			load: () => {
				runInNewContext(code, {
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
});
