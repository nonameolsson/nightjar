import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, configJsonSchema, loadConfig, loadRules } from './config.js';

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
			allowedCommands: ['make test', 'make lint *']
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

describe('the published JSON Schema', () => {
	it('is the schema factory.json is validated with (run npm run schema when this fails)', () => {
		const committed: unknown = JSON.parse(
			readFileSync(new URL('../schema/factory.schema.json', import.meta.url), 'utf8')
		);
		expect(committed).toEqual(configJsonSchema());
	});
});
