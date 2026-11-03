import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectChecks, detectTools } from './detect-check.js';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-detect-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (file: string, text: string) => writeFileSync(join(root, file), text);
const commands = (found: readonly { command: string }[]) => found.map((d) => d.command);

describe('detectChecks', () => {
	it('runs the package.json test script under bun, not bun test', () => {
		write('package.json', '{"scripts":{"test":"vitest run","check":"tsc"}}');
		write('bun.lock', '');
		expect(commands(detectChecks(root))).toEqual(['bun run check', 'bun run test']);
	});

	it('takes a Makefile target, not a variable of the same name', () => {
		write('Makefile', 'check := tsc\ntest ?= vitest\n');
		expect(detectChecks(root)).toEqual([]);
	});
});

describe('detectTools', () => {
	it('runs the package.json test script under bun, not bun test', () => {
		write('package.json', '{"scripts":{"test":"vitest run","lint":"eslint ."}}');
		write('bun.lockb', '');
		expect(commands(detectTools(root))).toEqual(['bun run test', 'bun run lint']);
	});

	it('takes a Makefile target, not a variable of the same name', () => {
		write('Makefile', 'lint := eslint\nbuild:\n\ttsc\n');
		expect(commands(detectTools(root))).toEqual(['make build']);
	});
});
