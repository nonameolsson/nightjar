import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
		expect(got.tail).toMatch(/^End of the output \(last 40 lines\):/);
	});

	it('names every failing test, from the stage log and without colour codes, when the check is red', async () => {
		mkdirSync(join(dir, 'logs'));
		writeFileSync(
			join(dir, 'logs', 'unit.log'),
			' FAIL  a.spec > one\n' + 'x\n'.repeat(300) + ' FAIL  b.spec > two\n'
		);
		const command =
			"printf 'unit  \\033[31mred\\033[0m\\n'; for i in $(seq 1 100); do echo line $i; done; exit 1";
		const got = await runCheck(command, dir, env, {
			stages: { red: '^(\\S+)\\s+red\\b', log: 'logs/{stage}.log' }
		});
		expect(got.ok).toBe(false);
		expect(got.tail).toContain('Red: unit');
		expect(got.tail).toContain('Failing tests (2):\n- a.spec > one\n- b.spec > two');
		expect(got.tail).toContain('line 100');
		expect(got.tail).not.toContain('\u001b');
	});

	it('reads no stage log from outside the worktree', async () => {
		const tree = join(dir, 'tree');
		mkdirSync(tree);
		writeFileSync(join(dir, 'outside.log'), ' FAIL  leaked > test\n');
		const got = await runCheck("echo 'unit red'; exit 1", tree, env, {
			stages: { red: '^(\\S+)\\s+red\\b', log: '../outside.log' }
		});
		expect(got.tail).not.toContain('leaked');
	});

	it('hands on only the plain tail when it is given no gate, as for the setup command', async () => {
		const got = await runCheck("echo ' FAIL  setup > step'; exit 1", dir, env);
		expect(got.tail).toBe('End of the output:\n FAIL  setup > step');
	});
});
