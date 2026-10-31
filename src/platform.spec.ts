// Native Windows stops every command with one message; WSL2 reports linux and is not stopped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNightjar } from './main.js';

let out: string[];
let err: string[];
beforeEach(() => {
	out = [];
	err = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
	vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});
afterEach(() => vi.restoreAllMocks());

describe('on native Windows', () => {
	it.each([
		[['doctor']],
		[['--dry-run']],
		[['init']],
		[['--once']],
		[['--watch']],
		[['42']],
		[['contract', './x.js']],
		[['--detach']],
		[[]]
	])('nightjar %j stops with the supported platforms', async (argv) => {
		const code = await runNightjar(argv, { platform: 'win32' });
		expect(code).toBe(2);
		expect(out).toEqual([]);
		expect(err).toEqual([
			'nightjar: native Windows is not supported; Nightjar runs on macOS, Linux and WSL2.'
		]);
	});
});

describe('on WSL2, which reports linux', () => {
	it('is not stopped for its platform', async () => {
		const code = await runNightjar(['--detach'], { platform: 'linux' });
		expect(code).toBe(2);
		expect(err.join('\n')).toContain('unknown argument --detach');
		expect(err.join('\n')).not.toContain('Windows');
	});
});
