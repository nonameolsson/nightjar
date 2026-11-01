// `nightjar contract MODULE` end to end: the real command, over modules written to a folder.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PACKAGE = join(import.meta.dirname, '..');
const TSX = join(PACKAGE, 'node_modules', '.bin', 'tsx');
const CLI = join(PACKAGE, 'src', 'cli.ts');
// the in-memory fakes are the adapters the modules below wrap
const HARNESS = pathToFileURL(join(PACKAGE, 'src', 'fakes', 'harness.ts')).href;

let dir: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-contract-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const nightjar = (...args: string[]) =>
	spawnSync(TSX, [CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 25_000 });

const mod = (name: string, text: string) => writeFileSync(join(dir, name), text);

const SOUND = `import { fakeCodeHostHarness, fakeTrackerHarness } from '${HARNESS}';
export const trackerHarness = fakeTrackerHarness;
export const codeHostHarness = fakeCodeHostHarness;`;

// a Tracker that never knows who is signed in
const FORGETFUL = `import { fakeTrackerHarness } from '${HARNESS}';
export const trackerHarness = async (world) => {
	const subject = await fakeTrackerHarness(world);
	subject.tracker.me = async () => '';
	return subject;
};`;

describe('nightjar contract', () => {
	it('runs both suites over a module and passes when every behaviour holds', () => {
		mod('sound.mjs', SOUND);
		const run = nightjar('contract', './sound.mjs');
		expect(run.stderr).toBe('');
		expect(run.stdout).toContain('Tracker contract');
		expect(run.stdout).toContain('Code host contract');
		expect(run.stdout).toContain('ok    names the signed-in person');
		expect(run.stdout).toMatch(/All \d+ behaviours pass\./);
		expect(run.status).toBe(0);
	});

	it('names each behaviour that fails, says why, and exits 1', () => {
		mod('forgetful.mjs', FORGETFUL);
		const run = nightjar('contract', './forgetful.mjs');
		expect(run.stdout).toContain('FAIL  names the signed-in person');
		expect(run.stdout).toContain("'' !== 'ann'");
		expect(run.stdout).toContain('ok    reads a Feature with its title and body');
		expect(run.stdout).toMatch(/2 of \d+ behaviours fail\./);
		expect(run.stdout).not.toContain('Code host contract');
		expect(run.status).toBe(1);
	});

	it('refuses a module that exports no harness, exit 2', () => {
		mod('bare.mjs', 'export const other = 1;');
		const run = nightjar('contract', './bare.mjs');
		expect(run.stderr).toBe(
			'nightjar: contract: ./bare.mjs exports neither trackerHarness nor codeHostHarness\n'
		);
		expect(run.status).toBe(2);
	});

	it('refuses a module it cannot load, exit 2', () => {
		const run = nightjar('contract', './nope.mjs');
		expect(run.stderr).toContain('nightjar: contract: cannot load ./nope.mjs');
		expect(run.status).toBe(2);
	});

	it.each([[[]], [['a.mjs', 'b.mjs']]])('says how to call it when given %j', (rest) => {
		const run = nightjar('contract', ...rest);
		expect(run.stderr).toContain('usage: nightjar contract MODULE');
		expect(run.status).toBe(2);
	});
});
