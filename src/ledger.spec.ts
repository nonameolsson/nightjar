import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { record, spentOn, type Entry } from './ledger.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'nightjar-ledger-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (at: Date, costUsd: number): Entry => ({
	at: at.toISOString(),
	repo: 'o/r',
	feature: '1',
	ticket: '2',
	branch: 'factory/1-a',
	step: 'build',
	session: 's',
	costUsd,
	outcome: 'built'
});

describe('spentOn', () => {
	it('adds up the local day and skips other days and broken lines', () => {
		const path = join(dir, 'nested', 'runs.jsonl');
		const morning = new Date(2026, 9, 30, 8, 0);
		record(path, entry(morning, 4.5));
		record(path, entry(new Date(2026, 9, 30, 23, 30), 1.25));
		record(path, entry(new Date(2026, 9, 29, 23, 59), 50));
		appendFileSync(path, 'not json\n{"at":"x"}\n');
		expect(spentOn(path, morning)).toBe(5.75);
	});

	it('counts a line written when ids were numbers', () => {
		const path = join(dir, 'runs.jsonl');
		const now = new Date(2026, 9, 30, 8, 0);
		appendFileSync(path, `${JSON.stringify({ ...entry(now, 2), feature: 1, ticket: 2 })}\n`);
		record(path, entry(now, 1));
		expect(spentOn(path, now)).toBe(3);
	});

	it('reads no file as nothing spent', () => {
		expect(spentOn(join(dir, 'none.jsonl'), new Date())).toBe(0);
	});
});
