// The Tracker makeAdapters builds speaks the trust factory.json gives it.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAdapters } from './adapters.js';
import { ConfigError, type Config } from './config.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'nightjar-adapters-'));
	// a gh whose only comment is by bob, who has write access
	const gh = join(dir, 'gh');
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
case "$*" in
  *permission*) echo '{"permission":"write"}' ;;
  *comments*) echo '[{"body":"hi","user":{"login":"bob"},"created_at":"2026-10-30T09:00:00Z","author_association":"NONE"}]' ;;
  *) echo '[]' ;;
esac`
	);
	chmodSync(gh, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (over: Partial<Config>): Config => ({
	tracker: { type: 'github', repo: 'o/r' },
	codeHost: { type: 'github', repo: 'o/r' },
	check: 'make check',
	allowedCommands: [],
	signals: DEFAULT_SIGNAL_NAMES,
	...over
});

const env = () => ({ ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` });

describe('makeAdapters', () => {
	it('trusts a writer by default', async () => {
		const { tracker } = await makeAdapters(config({}), dir, env());
		expect((await tracker.comments(1)).map((c) => c.trusted)).toEqual([true]);
	});

	it("trusts only the config's trusted list when it has one", async () => {
		const { tracker } = await makeAdapters(config({ trusted: ['ann'] }), dir, env());
		expect((await tracker.comments(1)).map((c) => c.trusted)).toEqual([false]);
	});
});

// Every method of the Tracker interface, as a module would write them; `over` adds or replaces one.
const trackerBody = (over = '') => `{
	me: async () => 'zed',
	assignedFeatures: async () => [],
	feature: async () => ({ id: 1, title: 't', body: '' }),
	tickets: async () => [],
	comments: async () => [],
	addSignal: async () => {},
	removeSignal: async () => {},
	comment: async () => {},
	reference: (id) => ({ id, text: '#' + id }),
	${over}
}`;

const HOST_BODY = `{
	push: async () => {},
	openPull: async () => null,
	createDraft: async () => ({ id: 1, url: 'u' }),
	editBody: async () => {},
	placeReferences: async () => {},
	comment: async () => {}
}`;

const moduleFile = (path: string, text: string) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
};

const refusal = async (c: Config): Promise<string> => {
	try {
		await makeAdapters(c, dir, env());
	} catch (fault) {
		if (fault instanceof ConfigError) return fault.message;
		throw fault;
	}
	throw new Error('the adapters were built');
};

describe('makeAdapters with a module', () => {
	it('builds the Tracker and the Code host from modules in the repo, resolved from its root', async () => {
		moduleFile(
			'adapters/tracker.mjs',
			`export const createTracker = async () => (${trackerBody()});`
		);
		moduleFile('host.mjs', `export const createCodeHost = () => (${HOST_BODY});`);
		const { tracker, codeHost, repo } = await makeAdapters(
			config({
				tracker: { type: 'module', path: './adapters/tracker.mjs' },
				codeHost: { type: 'module', path: 'host.mjs' }
			}),
			dir,
			env()
		);
		expect(await tracker.me()).toBe('zed');
		expect(await codeHost.openPull('b')).toBeNull();
		expect(repo).toBe('host.mjs');
	});

	it("hands the module the repo's root, its options, the Signal names and the trusted logins", async () => {
		moduleFile(
			'tracker.mjs',
			`export const createTracker = async (context) => (${trackerBody('me: async () => JSON.stringify(context),')});`
		);
		const { tracker } = await makeAdapters(
			config({
				tracker: { type: 'module', path: './tracker.mjs', options: { project: 'p' } },
				trusted: ['ann']
			}),
			dir,
			env()
		);
		expect(JSON.parse(await tracker.me())).toEqual({
			root: dir,
			options: { project: 'p' },
			signals: DEFAULT_SIGNAL_NAMES,
			trusted: ['ann']
		});
	});

	it('refuses a module that is not there, naming the path', async () => {
		const said = await refusal(config({ tracker: { type: 'module', path: './nope.mjs' } }));
		expect(said).toContain('factory.json: tracker: cannot load ./nope.mjs');
	});

	it('refuses a module that does not export the function that builds the adapter', async () => {
		moduleFile('tracker.mjs', 'export const other = 1;');
		moduleFile('host.mjs', 'export const createCodeHost = 1;');
		expect(await refusal(config({ tracker: { type: 'module', path: './tracker.mjs' } }))).toBe(
			'factory.json: tracker: ./tracker.mjs does not export createTracker, a function that builds the Tracker'
		);
		expect(await refusal(config({ codeHost: { type: 'module', path: './host.mjs' } }))).toBe(
			'factory.json: codeHost: ./host.mjs does not export createCodeHost, a function that builds the Code host'
		);
	});

	it('refuses an adapter that lacks methods of the interface, naming each', async () => {
		moduleFile(
			'tracker.mjs',
			`export const createTracker = () => { const t = ${trackerBody()}; delete t.comments; t.reference = 1; return t; };`
		);
		moduleFile('host.mjs', 'export const createCodeHost = () => ({ push: async () => {} });');
		expect(await refusal(config({ tracker: { type: 'module', path: './tracker.mjs' } }))).toBe(
			'factory.json: tracker: createTracker in ./tracker.mjs returned a Tracker without these methods: comments, reference'
		);
		expect(await refusal(config({ codeHost: { type: 'module', path: './host.mjs' } }))).toBe(
			'factory.json: codeHost: createCodeHost in ./host.mjs returned a Code host without these methods: openPull, createDraft, editBody, placeReferences, comment'
		);
	});

	it('says why a module that throws while it builds the adapter could not', async () => {
		moduleFile(
			'tracker.mjs',
			"export const createTracker = () => { throw new Error('no token'); };"
		);
		expect(await refusal(config({ tracker: { type: 'module', path: './tracker.mjs' } }))).toBe(
			'factory.json: tracker: createTracker in ./tracker.mjs failed: no token'
		);
	});
});
