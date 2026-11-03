// The contract of the Spend module, run over both adapters: the ledger file and memory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memorySpend } from './fakes/spend.js';
import { fileSpend } from './ledger.js';
import type { Entry, Spend } from './spend.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'nightjar-spend-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (at: Date, costUsd: number, over: Partial<Entry> = {}): Entry => ({
	at: at.toISOString(),
	repo: 'o/r',
	feature: '1',
	ticket: '2',
	branch: 'factory/1-a',
	step: 'build',
	session: 's',
	costUsd,
	outcome: 'built',
	...over
});

const adapters: [string, () => Spend][] = [
	['file', () => fileSpend(join(dir, 'nested', 'runs.jsonl'))],
	['in-memory', () => memorySpend()]
];

describe.each(adapters)('the %s Spend', (_name, make) => {
	const morning = new Date(2026, 9, 30, 8, 0);

	it('has nothing spent before anything is recorded', () => {
		const spend = make();
		expect(spend.entries()).toEqual([]);
		expect(spend.today(morning)).toBe(0);
		expect(spend.dayOver(morning, 60)).toBeNull();
	});

	it('gives back the entries recorded, oldest first', () => {
		const spend = make();
		const first = entry(morning, 4.5);
		const second = entry(new Date(2026, 9, 30, 9), 1, { step: 'fix', outcome: 'round 1' });
		spend.record(first);
		spend.record(second);
		expect(spend.entries()).toEqual([first, second]);
	});

	it('adds up the local day, not the others', () => {
		const spend = make();
		spend.record(entry(morning, 4.5));
		spend.record(entry(new Date(2026, 9, 30, 23, 30), 1.25));
		spend.record(entry(new Date(2026, 9, 29, 23, 59), 50));
		spend.record(entry(new Date(2026, 9, 31, 0, 1), 70));
		expect(spend.today(morning)).toBe(5.75);
	});

	it('says the day is over once it has spent its limit, in the words a person reads', () => {
		const spend = make();
		spend.record(entry(morning, 59.5));
		expect(spend.dayOver(morning, 60)).toBeNull();
		spend.record(entry(morning, 0.5));
		expect(spend.dayOver(morning, 60)).toBe(
			"today's estimated spend, $60.00, reached the daily limit of $60.00"
		);
		expect(spend.dayOver(new Date(2026, 9, 31, 8), 60)).toBeNull();
	});

	it('lets a piece of work spend what is left of its cap while that is $1 or more', () => {
		const spend = make();
		expect(spend.allowance(15, 3)).toEqual({ usd: 12, enough: true });
		expect(spend.allowance(15, 14)).toEqual({ usd: 1, enough: true });
		expect(spend.allowance(15, 14.5)).toEqual({ usd: 0.5, enough: false });
		expect(spend.allowance(15, 16)).toEqual({ usd: -1, enough: false });
	});
});
