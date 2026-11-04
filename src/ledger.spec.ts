import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builtOn, fileSpend, record } from './ledger.js';
import type { Entry } from './spend.js';

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

// What the Spend module's contract does not hold: the file's own format and how it reads a damaged one.
describe('fileSpend', () => {
	it('writes one JSON line per entry, and makes the folder', () => {
		const path = join(dir, 'nested', 'runs.jsonl');
		const first = entry(new Date(2026, 9, 30, 8), 4.5);
		const second = entry(new Date(2026, 9, 30, 9), 1);
		const spend = fileSpend(path);
		spend.record(first);
		spend.record(second);
		const lines = [first, second].map((e) => `${JSON.stringify(e)}\n`);
		expect(readFileSync(path, 'utf8')).toBe(lines.join(''));
	});

	it('skips broken lines', () => {
		const path = join(dir, 'runs.jsonl');
		const morning = new Date(2026, 9, 30, 8, 0);
		record(path, entry(morning, 4.5));
		appendFileSync(path, 'not json\n{"at":"x"}\n');
		record(path, entry(morning, 1.25));
		expect(fileSpend(path).today(morning)).toBe(5.75);
		expect(fileSpend(path).entries()).toHaveLength(2);
	});

	it('reads back a Pull-check fix round as its own kind of work, with its session and cost', () => {
		const path = join(dir, 'runs.jsonl');
		const morning = new Date(2026, 9, 30, 8, 0);
		const round: Entry = {
			...entry(morning, 2.5),
			ticket: null,
			step: 'pullChecks',
			session: 'session-2',
			outcome: 'pull checks 1'
		};
		fileSpend(path).record(round);
		expect(fileSpend(path).entries()).toEqual([round]);
		expect(builtOn(path, morning)).toBe(0);
	});

	it('counts a line written when ids were numbers', () => {
		const path = join(dir, 'runs.jsonl');
		const now = new Date(2026, 9, 30, 8, 0);
		appendFileSync(path, `${JSON.stringify({ ...entry(now, 2), feature: 1, ticket: 2 })}\n`);
		record(path, entry(now, 1));
		const spend = fileSpend(path);
		expect(spend.today(now)).toBe(3);
		expect(spend.entries()[0]).toMatchObject({ feature: '1', ticket: '2' });
	});

	it('reads no file as nothing spent', () => {
		expect(fileSpend(join(dir, 'none.jsonl')).today(new Date())).toBe(0);
	});
});

describe('builtOn', () => {
	it('counts the Tickets built on the local day, not fix rounds, other outcomes or other days', () => {
		const path = join(dir, 'runs.jsonl');
		const now = new Date(2026, 9, 30, 8, 0);
		record(path, entry(now, 1));
		record(path, entry(new Date(2026, 9, 30, 9, 0), 1));
		record(path, { ...entry(now, 1), outcome: 'questions, round 1' });
		record(path, { ...entry(now, 1), step: 'fix', outcome: 'built' });
		record(path, entry(new Date(2026, 9, 29, 9, 0), 1));
		expect(builtOn(path, now)).toBe(2);
		expect(builtOn(join(dir, 'none.jsonl'), now)).toBe(0);
	});
});
