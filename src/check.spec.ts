import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from './check.js';

let dir: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-check-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = { PATH: process.env.PATH };

describe('runCheck', () => {
	it('passes when the command exits 0', async () => {
		expect(await runCheck('true', dir, env)).toEqual({ ok: true, tail: '' });
	});

	it('runs the command through the shell in the worktree, and fails on a non-zero exit', async () => {
		const got = await runCheck('pwd && echo broken >&2 && exit 3', dir, env);
		expect(got.ok).toBe(false);
		expect(got.tail).toContain(dir);
		expect(got.tail).toContain('broken');
	});

	it('hands on the end of the output without colour codes, and says it was cut', async () => {
		const got = await runCheck(
			"for i in $(seq 1 500); do echo line $i; done; printf '\\033[31mred\\033[0m\\n'; exit 1",
			dir,
			env
		);
		expect(got.tail).toContain('line 500\nred');
		expect(got.tail).not.toContain('\u001b');
		expect(got.tail).not.toContain('line 1\n');
		expect(got.tail).toMatch(/^The end of the output \(last \d+ lines\):/);
	});
});
