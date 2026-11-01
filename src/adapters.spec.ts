// The Tracker makeAdapters builds speaks the trust factory.json gives it.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAdapters } from './adapters.js';
import { FakeAzureDevOps } from './azure-devops/fake-azure-devops.js';
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
		expect((await tracker.comments('1')).map((c) => c.trusted)).toEqual([true]);
	});

	it("trusts only the config's trusted list when it has one", async () => {
		const { tracker } = await makeAdapters(config({ trusted: ['ann'] }), dir, env());
		expect((await tracker.comments('1')).map((c) => c.trusted)).toEqual([false]);
	});

	it('builds Azure DevOps Boards as the Tracker, which says how to sign in when it cannot', async () => {
		// an az that is signed out, and no personal access token
		const az = join(dir, 'az');
		writeFileSync(
			az,
			`#!/usr/bin/env bash\necho "ERROR: Please run 'az login' to setup account." >&2\nexit 1`
		);
		chmodSync(az, 0o755);
		const noToken = { ...env(), AZURE_DEVOPS_EXT_PAT: undefined };
		const tracker = {
			type: 'azure-devops' as const,
			organization: 'contoso',
			project: 'Fabrikam',
			featureType: 'Feature'
		};
		const adapters = await makeAdapters(config({ tracker }), dir, noToken);
		expect(adapters.tracker.reference('7').text).toBe('AB#7');
		expect(adapters.checked('ann@contoso.com')).toBe(
			'Azure DevOps as ann@contoso.com on contoso/Fabrikam'
		);
		await expect(adapters.tracker.me()).rejects.toThrow(
			/cannot sign in to Azure DevOps: run `az login`, or set AZURE_DEVOPS_EXT_PAT/
		);
	});
});

// Every method of the Tracker interface, as a module would write them; `over` adds or replaces one.
const trackerBody = (over = '') => `{
	me: async () => 'zed',
	assignedFeatures: async () => [],
	feature: async () => ({ id: '1', title: 't', body: '' }),
	standing: async () => ({ assignees: [], signals: [] }),
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

const WRITER = `createFeature: async () => 1, createTicket: async () => 2, block: async () => {},`;

describe('makeAdapters and creating Features', () => {
	it('gives GitHub Issues as the Tracker that makes Features and Tickets', async () => {
		const { tracker, writer } = await makeAdapters(config({}), dir, env());
		expect(writer).toBe(tracker);
	});

	it('gives Azure DevOps Boards as one only once factory.json names the type of a Ticket', async () => {
		const tracker = {
			type: 'azure-devops' as const,
			organization: 'contoso',
			project: 'Fabrikam',
			featureType: 'Feature'
		};
		const without = await makeAdapters(config({ tracker }), dir, env());
		expect(without.writer).toBe(
			'factory.json: tracker.ticketType: name the work item type each Ticket is made as, such as User Story'
		);
		const named = await makeAdapters(
			config({ tracker: { ...tracker, ticketType: 'User Story' } }),
			dir,
			env()
		);
		expect(named.writer).toBe(named.tracker);
	});

	it('gives a module that has every method of FeatureWriter, and says why not of one that has none', async () => {
		moduleFile('writes.mjs', `export const createTracker = () => (${trackerBody(WRITER)});`);
		moduleFile('reads.mjs', `export const createTracker = () => (${trackerBody()});`);
		const writes = await makeAdapters(
			config({ tracker: { type: 'module', path: './writes.mjs' } }),
			dir,
			env()
		);
		expect(writes.writer).toBe(writes.tracker);
		const reads = await makeAdapters(
			config({ tracker: { type: 'module', path: './reads.mjs' } }),
			dir,
			env()
		);
		expect(reads.writer).toBe(
			'factory.json: tracker: ./reads.mjs makes no Features; its Tracker needs createFeature, createTicket and block'
		);
	});

	it('refuses a module that has some methods of FeatureWriter and not all, naming the rest', async () => {
		moduleFile(
			'half.mjs',
			`export const createTracker = () => (${trackerBody('createFeature: async () => 1,')});`
		);
		expect(await refusal(config({ tracker: { type: 'module', path: './half.mjs' } }))).toBe(
			'factory.json: tracker: createTracker in ./half.mjs returned a Tracker that makes Features without these methods: createTicket, block'
		);
	});
});

// An az signed in with the token the fake Azure DevOps takes, which notes each time it is asked.
function signedInAz() {
	const az = join(dir, 'az');
	writeFileSync(
		az,
		`#!/usr/bin/env bash\necho asked >> "${join(dir, 'az-asked')}"\necho '{"accessToken":"fake-azure-devops"}'`
	);
	chmodSync(az, 0o755);
	return () => readFileSync(join(dir, 'az-asked'), 'utf8').trim().split('\n').length;
}

const boards = (organization: string) => ({
	type: 'azure-devops' as const,
	organization,
	project: 'Fabrikam',
	featureType: 'Feature'
});

const repos = {
	type: 'azure-devops' as const,
	organization: 'contoso',
	project: 'Fabrikam',
	repo: 'app'
};

// The references a pull request on the fake Azure Repos shows: linked work items, and the body.
async function placed(c: Config, ticket: (ado: FakeAzureDevOps) => number) {
	const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
	ado.repository('app');
	const id = ticket(ado);
	const adapters = await makeAdapters(c, dir, env(), ado.request);
	const pull = await adapters.codeHost.createDraft({
		title: 'A',
		head: 'factory/1-a',
		base: 'main',
		body: 'Built.'
	});
	await adapters.codeHost.placeReferences(pull, [adapters.tracker.reference(String(id))]);
	return {
		text: adapters.tracker.reference(String(id)).text,
		linked: ado.linkedWorkItems(pull.id),
		body: ado.pullRequestAt(pull.id).description,
		adapters
	};
}

const pbi = (ado: FakeAzureDevOps) => ado.workItem({ type: 'Product Backlog Item', title: 'A' });

describe('makeAdapters pairs each Tracker with Azure Repos as the Code host', () => {
	it('links a work item of the same organization to the pull request, and names it #N', async () => {
		signedInAz();
		const got = await placed(config({ tracker: boards('Contoso'), codeHost: repos }), pbi);
		expect(got.text).toBe('#1');
		expect(got.linked).toEqual([1]);
		expect(got.body).toBe('Built.');
		expect(got.adapters.repo).toBe('contoso/Fabrikam/app');
		expect(got.adapters.checked('ann@contoso.com')).toBe(
			'Azure DevOps as ann@contoso.com on Contoso/Fabrikam, Azure Repos contoso/Fabrikam/app'
		);
	});

	it('signs in once for the Tracker and the Code host', async () => {
		const asked = signedInAz();
		const got = await placed(config({ tracker: boards('contoso'), codeHost: repos }), pbi);
		await got.adapters.tracker.me();
		await got.adapters.reachCodeHost();
		expect(asked()).toBe(1);
	});

	it('names a work item of another organization by its page, in the body', async () => {
		signedInAz();
		const got = await placed(config({ tracker: boards('northwind'), codeHost: repos }), () => 7);
		expect(got.text).toBe(
			'[work item 7](https://dev.azure.com/northwind/Fabrikam/_workitems/edit/7)'
		);
		expect(got.linked).toEqual([]);
		expect(got.body).toContain(`- ${got.text}`);
	});

	it('names a GitHub issue by its page, never as #N, which Azure Repos reads as a work item', async () => {
		signedInAz();
		const got = await placed(config({ codeHost: repos }), () => 7);
		expect(got.text).toBe('[issue 7](https://github.com/o/r/issues/7)');
		expect(got.linked).toEqual([]);
		expect(got.body).toContain(`- ${got.text}`);
	});

	it("places a module Tracker's own reference in the body", async () => {
		signedInAz();
		moduleFile('tracker.mjs', `export const createTracker = async () => (${trackerBody()});`);
		const got = await placed(
			config({ tracker: { type: 'module', path: './tracker.mjs' }, codeHost: repos }),
			() => 7
		);
		expect(got.text).toBe('#7');
		expect(got.linked).toEqual([]);
		expect(got.body).toContain('- #7');
	});

	it('keeps the references GitHub as the Code host places: #N, and AB#N for a work item', async () => {
		expect((await makeAdapters(config({}), dir, env())).tracker.reference('7').text).toBe('#7');
		const adapters = await makeAdapters(config({ tracker: boards('contoso') }), dir, env());
		expect(adapters.tracker.reference('7').text).toBe('AB#7');
	});

	it('stops before a build when the Azure Repos repo cannot be read', async () => {
		signedInAz();
		const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
		const adapters = await makeAdapters(config({ codeHost: repos }), dir, env(), ado.request);
		await expect(adapters.reachCodeHost()).rejects.toThrow(/could not read the repo app: HTTP 404/);
	});

	it('still makes Features through the Tracker whose references it rewrites for Azure Repos', async () => {
		const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
		const tracker = { ...boards('contoso'), ticketType: 'Product Backlog Item' };
		const adapters = await makeAdapters(
			config({ tracker, codeHost: repos }),
			dir,
			env(),
			ado.request
		);
		signedInAz();
		if (typeof adapters.writer === 'string') throw new Error(adapters.writer);
		const feature = await adapters.writer.createFeature({ title: 'A', body: 'The spec.' });
		expect((await adapters.tracker.feature(feature)).title).toBe('A');
	});
});
