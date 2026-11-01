// `nightjar --help` is how a newcomer checks an install worked: usage on stdout, exit 0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE } from './args.js';
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

describe('nightjar --help', () => {
	it.each([['--help'], ['-h'], ['help']])('%s prints the usage and exits 0', async (flag) => {
		const code = await runNightjar([flag], { platform: 'linux' });
		expect(code).toBe(0);
		expect(out).toEqual([USAGE]);
		expect(err).toEqual([]);
	});
});
