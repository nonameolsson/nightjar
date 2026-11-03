import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const status = () =>
	new StatusFile({
		path: join(root, '.factory', 'status.json'),
		ledger: ledgerFile(),
		now: () => at,
		pid: process.pid,
		dailyUsd: 8
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

describe('nightjar ui page, more', () => {
	it('shows a paused run with why', async () => {
		status().doing({ kind: 'paused', why: 'daily limit reached', until: null });
		await open();
		const page = (await get('/')).text;
		expect(page).toContain('<span class="state">paused</span>');
		expect(page).toContain('daily limit reached');
	});
});
