// `nightjar ui` as a command: its arguments, the repo root it finds, and a port that is taken.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE } from './args.js';
import { runNightjar } from './main.js';

let dir: string;
let out: string[];
let err: string[];
let held: Server | null;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-ui-command-')));
	spawnSync('git', ['init', '-q'], { cwd: dir });
	out = [];
	err = [];
	held = null;
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
	vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await new Promise((done) => (held === null ? done(null) : held.close(done)));
	rmSync(dir, { recursive: true, force: true });
});

const host = (cwd: string) => ({
	platform: 'linux' as const,
	env: { PATH: process.env.PATH },
	cwd
});

// the port a started `nightjar ui` says it serves on
const servedPort = () => {
	const line = out.find((l) => l.includes('http://127.0.0.1:'));
	return Number(/127\.0\.0\.1:(\d+)/.exec(line ?? '')?.[1]);
};

describe('nightjar ui', () => {
	it('is listed by nightjar help', () => {
		expect(USAGE).toMatch(/\bui\b.*--port/);
	});

	it('serves the .factory/ of the repo root of the current directory, until it is told to stop', async () => {
		mkdirSync(join(dir, '.factory'));
		writeFileSync(
			join(dir, '.factory', 'status.json'),
			JSON.stringify({
				at: '2026-10-30T08:00:00.000Z',
				// the page lists what completed whether or not this pid is alive
				pid: 42,
				spentTodayUsd: 0,
				dailyUsd: 8,
				doing: { kind: 'idle', nextPollAt: '2026-10-30T08:02:00.000Z' },
				recent: [
					{ seq: 1, at: '2026-10-30T07:50:00.000Z', kind: 'failed', feature: '77', why: 'nope' }
				]
			})
		);
		const sub = join(dir, 'packages', 'app');
		mkdirSync(sub, { recursive: true });
		const stop = new AbortController();
		const done = runNightjar(['ui', '--port', '0'], { ...host(sub), stop: stop.signal });
		await vi.waitFor(() => expect(servedPort()).toBeGreaterThan(0));
		const page = await (await fetch(`http://127.0.0.1:${String(servedPort())}/`)).text();
		expect(page).toContain('failed: nope');
		stop.abort();
		expect(await done).toBe(0);
	});

	it('says the port is taken, and exits 2', async () => {
		held = createServer();
		await new Promise<void>((ready) => held?.listen(0, '127.0.0.1', ready));
		const taken = (held.address() as { port: number }).port;
		const code = await runNightjar(['ui', '--port', String(taken)], host(dir));
		expect(code).toBe(2);
		expect(err.join('\n')).toContain(`port ${String(taken)} is taken`);
	});

	it('has no flag to widen where it listens', async () => {
		for (const argv of [
			['--host', '0.0.0.0'],
			['--port'],
			['--port', 'x'],
			['--port', '70000'],
			['5']
		]) {
			err = [];
			expect(await runNightjar(['ui', ...argv], host(dir))).toBe(2);
			expect(err.join('\n')).toContain('nightjar ui');
		}
	});

	it('refuses outside a git checkout', async () => {
		const loose = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-ui-loose-')));
		try {
			// the temp dir may itself sit in a checkout on some machines; GIT_CEILING_DIRECTORIES keeps git from climbing
			const code = await runNightjar(['ui'], {
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
