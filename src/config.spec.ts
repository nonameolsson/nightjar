import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, configJsonSchema, loadConfig, loadRules } from './config.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-config-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const VALID = {
	$schema: './node_modules/@nonameolsson/nightjar/schema/factory.schema.json',
	tracker: { type: 'github' },
	codeHost: { type: 'github', repo: 'o/r' },
	check: 'make check',
	allowedCommands: ['make test', 'make lint *']
};

const write = (value: unknown) =>
	writeFileSync(join(root, 'factory.json'), JSON.stringify(value, null, '\t'));

const without = (key: keyof typeof VALID) =>
	Object.fromEntries(Object.entries(VALID).filter(([k]) => k !== key));

const loadValid = () => {
	write(VALID);
	return loadConfig(root);
};

const refusal = (): string => {
	try {
		loadConfig(root);
	} catch (fault) {
		if (fault instanceof ConfigError) return fault.message;
		throw fault;
	}
	throw new Error('the config loaded');
};

describe('loadConfig', () => {
	it('loads a valid factory.json', () => {
		write(VALID);
		expect(loadConfig(root)).toEqual({
			tracker: { type: 'github' },
			codeHost: { type: 'github', repo: 'o/r' },
			check: 'make check',
			allowedCommands: ['make test', 'make lint *'],
			signals: DEFAULT_SIGNAL_NAMES
		});
	});

	it('loads the prompt, model and review settings, and leaves them out when not set', () => {
		write({
			...VALID,
			rules: 'docs/rules.md',
			model: 'sonnet',
			effort: 'high',
			review: { enabled: false, model: 'opus', effort: 'medium' }
		});
		expect(loadConfig(root)).toMatchObject({
			rules: 'docs/rules.md',
			model: 'sonnet',
			effort: 'high',
			review: { enabled: false, model: 'opus', effort: 'medium' }
		});
		write(VALID);
		expect(loadConfig(root)).not.toHaveProperty('review');
	});

	it('refuses a review setting that is not one it knows', () => {
		write({ ...VALID, review: { enabled: 'no' } });
		expect(refusal()).toMatch(/^factory\.json: review\.enabled: /m);
		write({ ...VALID, review: { model: 'opus', off: true } });
		expect(refusal()).toMatch(/off/);
	});

	it('loads a Tracker and a Code host named as a module path, with their options', () => {
		const modules = {
			tracker: { type: 'module', path: './adapters/tracker.js', options: { project: 'x' } },
			codeHost: { type: 'module', path: './adapters/host.js' }
		};
		write({ ...VALID, ...modules });
		expect(loadConfig(root)).toMatchObject(modules);
	});

	it.each([
		['no path', { type: 'module' }, 'tracker.path'],
		['an empty path', { type: 'module', path: ' ' }, 'tracker.path'],
		['a field it does not know', { type: 'module', path: './t.js', repo: 'o/r' }, 'tracker']
	])('refuses a module Tracker with %s, naming the field', (_what, tracker, field) => {
		write({ ...VALID, tracker });
		expect(refusal()).toContain(`factory.json: ${field}`);
	});

	it('refuses a file with no check command, and never supplies one', () => {
		write(without('check'));
		expect(refusal()).toMatch(/^factory\.json: check: missing/m);
	});

	it('refuses an empty check command', () => {
		write({ ...VALID, check: '  ' });
		expect(refusal()).toMatch(/^factory\.json: check: /m);
	});

	it('refuses a file with no allowed commands', () => {
		write(without('allowedCommands'));
		expect(refusal()).toMatch(/^factory\.json: allowedCommands: /m);
	});

	it('loads a setup command and reserved ports, and sets neither by itself', () => {
		write(VALID);
		expect(loadConfig(root)).not.toHaveProperty('setup');
		expect(loadConfig(root)).not.toHaveProperty('ports');
		const asked = { setup: 'make deps', ports: { count: 5, env: ['WEB_PORT', 'DB_PORT'] } };
		write({ ...VALID, ...asked });
		expect(loadConfig(root)).toMatchObject(asked);
	});

	it('refuses an empty setup command', () => {
		write({ ...VALID, setup: ' ' });
		expect(refusal()).toMatch(/^factory\.json: setup: /m);
	});

	it.each([
		['no ports', { count: 0, env: ['WEB_PORT'] }, 'ports.count'],
		['no variable names', { count: 2, env: [] }, 'ports.env'],
		['more names than ports', { count: 1, env: ['A_PORT', 'B_PORT'] }, 'ports.env'],
		['a name twice', { count: 2, env: ['A_PORT', 'A_PORT'] }, 'ports.env'],
		['a name that is no variable', { count: 2, env: ['A PORT'] }, 'ports.env.0'],
		['no variable names at all', { count: 2 }, 'ports.env']
	])('refuses reserved ports with %s, naming the field', (_what, ports, field) => {
		write({ ...VALID, ports });
		expect(refusal()).toContain(`factory.json: ${field}: `);
	});

	it('refuses a tracker it does not know, naming the field', () => {
		write({ ...VALID, tracker: { type: 'paper' } });
		expect(refusal()).toMatch(/^factory\.json: tracker\.type: /m);
	});

	it('loads Azure DevOps Boards as the Tracker, with its organization, project and Feature type', () => {
		const tracker = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam Fiber',
			featureType: 'Product Backlog Item'
		};
		write({ ...VALID, tracker });
		expect(loadConfig(root).tracker).toEqual(tracker);
	});

	it.each([
		['organization', 'tracker.organization'],
		['project', 'tracker.project'],
		['featureType', 'tracker.featureType']
	])('refuses an Azure DevOps Tracker with no %s, naming the field', (key, field) => {
		const whole = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam',
			featureType: 'Feature'
		};
		const tracker = Object.fromEntries(Object.entries(whole).filter(([k]) => k !== key));
		write({ ...VALID, tracker });
		expect(refusal()).toMatch(new RegExp(`^factory\\.json: ${field}: missing: `, 'm'));
	});

	it('loads the work item type a Ticket is made as, for nightjar create', () => {
		const tracker = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam',
			featureType: 'Feature',
			ticketType: 'User Story'
		};
		write({ ...VALID, tracker });
		expect(loadConfig(root).tracker).toEqual(tracker);
		write({ ...VALID, tracker: { ...tracker, ticketType: ' ' } });
		expect(refusal()).toMatch(/^factory\.json: tracker\.ticketType: /m);
	});

	it('refuses an Azure DevOps organization given as an address, not a name', () => {
		const tracker = {
			type: 'azure-devops',
			organization: 'https://dev.azure.com/contoso',
			project: 'Fabrikam',
			featureType: 'Feature'
		};
		write({ ...VALID, tracker });
		expect(refusal()).toMatch(/^factory\.json: tracker\.organization: /m);
	});

	it('loads Azure Repos as the Code host, with its organization, project and repo', () => {
		const codeHost = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam Fiber',
			repo: 'Fiber App'
		};
		write({ ...VALID, codeHost });
		expect(loadConfig(root).codeHost).toEqual(codeHost);
	});

	it.each([
		['organization', 'codeHost.organization'],
		['project', 'codeHost.project'],
		['repo', 'codeHost.repo']
	])('refuses an Azure Repos Code host with no %s, naming the field', (key, field) => {
		const whole = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam',
			repo: 'app'
		};
		const codeHost = Object.fromEntries(Object.entries(whole).filter(([k]) => k !== key));
		write({ ...VALID, codeHost });
		expect(refusal()).toMatch(new RegExp(`^factory\\.json: ${field}: missing: `, 'm'));
	});

	it('refuses an Azure Repos organization given as an address, not a name', () => {
		const codeHost = {
			type: 'azure-devops',
			organization: 'dev.azure.com/contoso',
			project: 'Fabrikam',
			repo: 'app'
		};
		write({ ...VALID, codeHost });
		expect(refusal()).toMatch(/^factory\.json: codeHost\.organization: /m);
	});

	it('refuses a code host repo that is not owner/name', () => {
		write({ ...VALID, codeHost: { type: 'github', repo: 'just-a-name' } });
		expect(refusal()).toMatch(/^factory\.json: codeHost\.repo: /m);
	});

	it('refuses a field it does not know, so a typo is never ignored', () => {
		write({ ...VALID, checks: 'make check' });
		expect(refusal()).toMatch(/checks/);
	});

	it('says so when there is no factory.json, or it is not JSON', () => {
		expect(refusal()).toMatch(/no factory\.json/);
		writeFileSync(join(root, 'factory.json'), '{"check":');
		expect(refusal()).toMatch(/factory\.json is not JSON/);
	});
});

describe('loadRules', () => {
	it('is null without a rules file, else the text of the file named, from the repo root', () => {
		const config = { ...loadValid(), rules: 'rules.md' };
		expect(loadRules(root, loadValid())).toBeNull();
		writeFileSync(join(root, 'rules.md'), 'Write small functions.\n');
		expect(loadRules(root, config)).toBe('Write small functions.');
	});

	it('refuses a rules file that cannot be read, naming it', () => {
		const config = { ...loadValid(), rules: 'missing.md' };
		expect(() => loadRules(root, config)).toThrow(/factory\.json: rules: cannot read missing\.md/);
	});
});

describe('Signal names in factory.json', () => {
	it('defaults to the names that match the triage roles, with a Go of its own', () => {
		write(VALID);
		expect(loadConfig(root).signals).toEqual({
			go: 'factory-go',
			ready: 'ready-for-agent',
			working: 'agent-working',
			needsInfo: 'needs-info',
			human: 'ready-for-human'
		});
	});

	it('renames one Signal and leaves the rest at their defaults', () => {
		write({ ...VALID, signals: { working: 'bot-busy' } });
		expect(loadConfig(root).signals).toEqual({ ...DEFAULT_SIGNAL_NAMES, working: 'bot-busy' });
	});

	it('lets the Go share the name of ready, which gives the one-label behaviour', () => {
		write({ ...VALID, signals: { go: 'ready-for-agent' } });
		const { signals } = loadConfig(root);
		expect(signals.go).toBe('ready-for-agent');
		expect(signals.ready).toBe('ready-for-agent');
	});

	it.each(['needs-triage', 'wontfix'])('refuses %s, which Nightjar never reads or sets', (name) => {
		write({ ...VALID, signals: { human: name } });
		expect(refusal()).toMatch(/^factory\.json: signals\.human: .*never reads or sets/m);
	});

	it('refuses an empty name and a Signal it does not know', () => {
		write({ ...VALID, signals: { go: ' ' } });
		expect(refusal()).toMatch(/^factory\.json: signals\.go: /m);
		write({ ...VALID, signals: { stuck: 'stuck' } });
		expect(refusal()).toMatch(/stuck/);
	});
});

describe('the trusted list in factory.json', () => {
	it('is left out unless the repo writes one, so the Tracker adapter default holds', () => {
		write(VALID);
		expect(loadConfig(root).trusted).toBeUndefined();
	});

	it('loads the logins it names', () => {
		write({ ...VALID, trusted: ['ann', 'bob'] });
		expect(loadConfig(root).trusted).toEqual(['ann', 'bob']);
	});

	it('refuses an empty login', () => {
		write({ ...VALID, trusted: ['ann', ''] });
		expect(refusal()).toMatch(/^factory\.json: trusted\.1: /m);
	});
});

describe('the published JSON Schema', () => {
	it('is the schema factory.json is validated with (run npm run schema when this fails)', () => {
		const committed: unknown = JSON.parse(
			readFileSync(new URL('../schema/factory.schema.json', import.meta.url), 'utf8')
		);
		expect(committed).toEqual(configJsonSchema());
	});
});
