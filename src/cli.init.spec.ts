// `nightjar init` as a process, answers piped in with no terminal, over stand-ins that are all the PATH holds.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { machine, type Machine } from './fakes/machine.js';

const PACKAGE = join(import.meta.dirname, '..');
const TSX = join(PACKAGE, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(PACKAGE, 'src', 'cli.ts');

let m: Machine;
afterEach(() => m.remove());

// node is started by its full path, since the PATH holds the stand-ins alone
const nightjar = (input: string) =>
	spawnSync(process.execPath, [TSX, CLI, 'init'], {
		cwd: m.root,
		env: m.env,
		input,
		encoding: 'utf8',
		timeout: 25_000
	});

describe('nightjar init with answers on standard input', () => {
	it('asks each question, writes factory.json and creates the labels', () => {
		m = machine();
		const run = nightjar('github\n\ngithub\n\nmake check\n\n');
		expect(run.stderr).toBe('');
		expect(run.status).toBe(0);
		expect(run.stdout).toContain(
			'Command that checks the work, run after each Ticket (no default): make check'
		);
		expect(m.readConfig()).toMatchObject({ check: 'make check', allowedCommands: ['make check'] });
		expect(m.calls('gh')).toContain('-X POST repos/o/r/labels -f name=factory-go ');
		expect(run.stdout).toContain('nightjar: created the label factory-go');
	}, 30_000);

	it('stops without writing when the input ends before the check command', () => {
		m = machine();
		const run = nightjar('github\n\ngithub\n\n');
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('nightjar: the input ended before this was answered');
		expect(existsSync(join(m.root, 'factory.json'))).toBe(false);
	}, 30_000);
});
