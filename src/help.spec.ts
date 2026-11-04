// `nightjar --help` is how a newcomer checks an install worked: usage on stdout, exit 0.
import { readFileSync } from 'node:fs';
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

	it('names doctor with a Feature', async () => {
		await runNightjar(['--help'], { platform: 'linux' });
		expect(out.join('\n')).toContain('doctor [FEATURE]');
		expect(out.join('\n')).toContain('doctor FEATURE');
	});
});

describe('nightjar --version', () => {
	it.each([['--version'], ['-v']])('%s prints the package version and exits 0', async (flag) => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
			version: string;
		};
		const code = await runNightjar([flag], { platform: 'linux' });
		expect(code).toBe(0);
		expect(out).toEqual([pkg.version]);
		expect(err).toEqual([]);
	});
});
