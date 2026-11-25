// `nightjar logbook` through runNightjar, over mock .factory/ files in a git checkout: no Tracker, no login.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE } from './args.js';
import { ledgerPath, record } from './ledger.js';
import { fileLogbook, type Decision, type Place } from './logbook.js';
import { runNightjar } from './main.js';
import type { Entry } from './spend.js';

let dir: string;
let out: string[];
let err: string[];
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-logbook-command-')));
	spawnSync('git', ['init', '-q'], { cwd: dir });
	out = [];
	err = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
	vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

// no login, no PATH beyond git's: the command reads .factory/ alone
const host = (cwd: string) => ({
	os: { platform: 'linux' as const, kernel: '' },
	env: { PATH: process.env.PATH },
	cwd
});

const at = (minute: number) => new Date(2026, 9, 30, 9, minute).toISOString();

const ran = (minute: number, over: Partial<Entry>): Entry => ({
	at: at(minute),
	repo: 'o/app',
	feature: '1',
	ticket: '2',
	branch: 'factory/1-one',
	step: 'build',
	session: 'session-1',
	costUsd: 3,
	outcome: 'built',
	durationMs: 62_000,
	...over
});

const decided = (minute: number, entry: Decision & Place) =>
	fileLogbook(dir).write({ at: at(minute), feature: '1', ...entry });

const transcript = (id: string, lines: unknown[]) => {
	mkdirSync(join(dir, '.factory', 'logs'), { recursive: true });
	writeFileSync(
		join(dir, '.factory', 'logs', `${id}.jsonl`),
		lines.map((l) => JSON.stringify(l)).join('\n')
	);
};

const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });
const results = (...content: unknown[]) => ({ type: 'user', message: { content } });

// a line without its time, which shows in the machine's own zone
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}/gm;
const untimed = (text: string) => text.replace(STAMP, '<time>  ');

describe('nightjar logbook FEATURE', () => {
	it('is listed by nightjar --help', () => {
		expect(USAGE).toMatch(/nightjar logbook FEATURE/);
		expect(USAGE).toMatch(/nightjar logbook --session ID \[--full\]/);
	});

	it("prints the Logbook in order, with each Session's transcript path", async () => {
		decided(0, { kind: 'buildStarted', by: 'go', branch: 'factory/1-one', workflow: null });
		decided(0, { kind: 'ticketStarted', ticket: '2' });
		record(ledgerPath(dir), ran(4, {}));
		decided(4, {
			kind: 'checkRed',
			report: 'lint: 1 problem\nsrc/a.ts:3 unused',
			round: 1,
			rounds: 3,
			ticket: '2',
			session: 'session-1'
		});
		record(ledgerPath(dir), ran(6, { step: 'fix', outcome: 'round 1', costUsd: 1 }));
		decided(7, { kind: 'ticketBuilt', commit: 'abc1234', ticket: '2' });
		record(
			ledgerPath(dir),
			ran(9, { ticket: null, step: 'review', session: 'session-2', outcome: 'approve' })
		);
		// another Feature's Session is not this one's
		record(ledgerPath(dir), ran(10, { feature: '9', session: 'session-9' }));
		const sub = join(dir, 'packages', 'app');
		mkdirSync(sub, { recursive: true });

		const code = await runNightjar(['logbook', '#1'], host(sub));

		expect(code).toBe(0);
		expect(err).toEqual([]);
		expect(untimed(out.join('\n')).split('\n')).toEqual([
			'Logbook of #1: 3 Sessions, $7.00',
			'<time>  Build started by the Go on factory/1-one',
			'<time>  Ticket #2: Ticket started',
			'<time>  Session session-1: build, Ticket #2, built, $3.00, 1m 02s',
			`    transcript: ${join(dir, '.factory', 'logs', 'session-1.jsonl')}`,
			'<time>  Ticket #2: Check red, so fix round 1 of 3',
			'    Gate report:',
			'      lint: 1 problem',
			'      src/a.ts:3 unused',
			'<time>  Session session-1: fix round, Ticket #2, round 1, $1.00, 1m 02s',
			`    transcript: ${join(dir, '.factory', 'logs', 'session-1.jsonl')}`,
			'<time>  Ticket #2: Ticket built in commit abc1234',
			'<time>  Session session-2: Review, the whole Feature, approve, $3.00, 1m 02s',
			`    transcript: ${join(dir, '.factory', 'logs', 'session-2.jsonl')}`
		]);
	});

	it('says a Feature built before the Logbook existed shows its Sessions only', async () => {
		record(ledgerPath(dir), ran(4, {}));
		expect(await runNightjar(['logbook', '1'], host(dir))).toBe(0);
		expect(out.join('\n')).toContain('did not record Nightjar');
		expect(out.join('\n')).toContain('Session session-1');
	});

	it('names Signals as factory.json does', async () => {
		writeFileSync(
			join(dir, 'factory.json'),
			JSON.stringify({
				tracker: { type: 'github', repo: 'o/app' },
				codeHost: { type: 'github', repo: 'o/app' },
				check: 'npm test',
				allowedCommands: ['npm test'],
				signals: { go: 'ship-it' }
			})
		);
		decided(0, { kind: 'signal', signal: 'go', on: false });
		expect(await runNightjar(['logbook', '1'], host(dir))).toBe(0);
		expect(out.join('\n')).toContain('Signal `ship-it` taken off');
	});

	it('prints a plain message and exits 1 for a Feature with nothing recorded', async () => {
		record(ledgerPath(dir), ran(4, {}));
		expect(await runNightjar(['logbook', '77'], host(dir))).toBe(1);
		expect(out).toEqual([]);
		expect(err.join('\n')).toContain('nothing recorded for Feature #77');
	});
});

describe('nightjar logbook --session ID', () => {
	const build = () => {
		transcript('session-1', [
			assistant({ type: 'text', text: 'Reading the code' }),
			assistant({ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }),
			results({ type: 'tool_result', tool_use_id: 't', content: 'all green' }),
			assistant({ type: 'tool_use', name: 'Edit', input: { file_path: 'src/x.ts' } })
		]);
		record(ledgerPath(dir), ran(4, {}));
	};

	it("prints the Session's summary: its text and a line per tool call, with no tool result", async () => {
		build();
		expect(await runNightjar(['logbook', '--session', 'session-1'], host(dir))).toBe(0);
		expect(untimed(out.join('\n')).split('\n')).toEqual([
			'Session session-1',
			'<time>  Feature #1: build, Ticket #2, built, $3.00, 1m 02s',
			'',
			'Reading the code',
			'  Bash: npm test',
			'  Edit: src/x.ts'
		]);
	});

	it('adds each tool result with --full', async () => {
		build();
		expect(await runNightjar(['logbook', '--session', 'session-1', '--full'], host(dir))).toBe(0);
		const said = out.join('\n');
		expect(said).toContain('  Bash: npm test\n  Result:\n    all green\n  Edit: src/x.ts');
	});

	it('prints a plain message and exits 1 for a Session with no transcript, or no Session id', async () => {
		expect(await runNightjar(['logbook', '--session', 'nope'], host(dir))).toBe(1);
		expect(err.join('\n')).toContain('no transcript for Session nope');
		err = [];
		expect(await runNightjar(['logbook', '--session', '../runs'], host(dir))).toBe(1);
		expect(err.join('\n')).toContain('no transcript for Session ../runs');
		expect(out).toEqual([]);
	});
});

describe('nightjar logbook arguments', () => {
	it.each([
		[[], 'say which Feature'],
		[['--full'], '--full goes with --session only'],
		[['1', '--full'], '--full goes with --session only'],
		[['--session'], '--session needs a Session id'],
		[['--session', '--full'], '--session needs a Session id'],
		[['1', '--session', 'a'], 'not both'],
		[['1', '2'], 'choose one Feature'],
		[['--session', 'a', '--session', 'b'], 'choose one Session'],
		[['--bogus'], 'unknown argument --bogus']
	])('refuses %j, exiting 2 with the usage', async (argv, said) => {
		expect(await runNightjar(['logbook', ...argv], host(dir))).toBe(2);
		expect(err.join('\n')).toContain(said);
		expect(err.join('\n')).toContain('usage: nightjar logbook FEATURE');
	});

	it('refuses outside a git checkout', async () => {
		const loose = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-logbook-loose-')));
		try {
			const code = await runNightjar(['logbook', '1'], {
				...host(loose),
				env: { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: tmpdir() }
			});
			expect(code).toBe(2);
			expect(err.join('\n')).toContain('not inside a git checkout');
		} finally {
			rmSync(loose, { recursive: true, force: true });
		}
	});
});
