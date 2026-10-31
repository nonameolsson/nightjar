import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, configJsonSchema, loadConfig } from './config.js';

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
			allowedCommands: ['make test', 'make lint *']
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

describe('the published JSON Schema', () => {
	it('is the schema factory.json is validated with (run npm run schema when this fails)', () => {
		const committed: unknown = JSON.parse(
			readFileSync(new URL('../schema/factory.schema.json', import.meta.url), 'utf8')
		);
		expect(committed).toEqual(configJsonSchema());
	});
});
