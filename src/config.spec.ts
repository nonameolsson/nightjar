import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, configJsonSchema, loadConfig } from './config.js';
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

	it('refuses a tracker it does not know, naming the field', () => {
		write({ ...VALID, tracker: { type: 'paper' } });
		expect(refusal()).toMatch(/^factory\.json: tracker\.type: /m);
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
