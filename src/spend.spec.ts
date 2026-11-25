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

	describe('with Sessions running in other Slots', () => {
		it('does not start a second Session when the day cannot hold its cap beside the one running', () => {
			const spend = make();
			spend.record(entry(morning, 50));
			spend.reserve(5);
			expect(spend.dayOver(morning, 60, 10)).toBe(
				"today's estimated spend, $50.00, plus $5.00 held for the Sessions running in other Slots and $10.00 for this Session would pass the daily limit of $60.00"
			);
			expect(spend.hold(10, morning, 60)).toBe(
				"today's estimated spend, $50.00, plus $5.00 held for the Sessions running in other Slots and $10.00 for this Session would pass the daily limit of $60.00"
			);
			// the work's own cap is not cut by the other Slots: it pauses where its Session starts instead
			expect(spend.allowance(10, 0)).toEqual({ usd: 10, enough: true });
			// one that fits still starts
			expect(spend.dayOver(morning, 60, 5)).toBeNull();
			expect(typeof spend.hold(5, morning, 60)).toBe('object');
		});

		it('checks and holds in one step, so two Sessions cannot both start on the same dollars', () => {
			const spend = make();
			spend.record(entry(morning, 55));
			// both Slots passed the check where their work started
			expect(spend.dayOver(morning, 60, 10)).toBeNull();
			const first = spend.hold(10, morning, 60);
			expect(typeof first).toBe('object');
			expect(spend.hold(10, morning, 60)).toBe(
				"today's estimated spend, $55.00, plus $10.00 held for the Sessions running in other Slots, reached the daily limit of $60.00"
			);
			// once the first ends, the second may start
			if (typeof first !== 'string') first.release();
			expect(typeof spend.hold(10, morning, 60)).toBe('object');
		});

		it('says the day is over when the spend and the caps running reach the limit', () => {
			const spend = make();
			spend.record(entry(morning, 50));
			spend.reserve(10);
			expect(spend.dayOver(morning, 60)).toBe(
				"today's estimated spend, $50.00, plus $10.00 held for the Sessions running in other Slots, reached the daily limit of $60.00"
			);
		});

		it('counts every Session running', () => {
			const spend = make();
			spend.reserve(10);
			spend.reserve(10);
			expect(spend.dayOver(morning, 30, 10)).toBeNull();
			expect(spend.dayOver(morning, 29, 10)).not.toBeNull();
		});

		it('gives the cap back when its Session ends, and counts what it spent in its place', () => {
			const spend = make();
			spend.record(entry(morning, 50));
			const running = spend.reserve(5);
			expect(spend.dayOver(morning, 60, 10)).not.toBeNull();
			// the Session ends having spent $2, and its ledger line takes the cap's place
			spend.record(entry(morning, 2));
			running.release();
			expect(spend.today(morning)).toBe(52);
			expect(spend.dayOver(morning, 60, 10)).toBeNull();
			expect(typeof spend.hold(8, morning, 60)).toBe('object');
			// a second release gives nothing back twice
			running.release();
			expect(spend.dayOver(morning, 60, 1)).not.toBeNull();
		});

		it('leaves the day over once it is, while the Session running finishes', () => {
			const spend = make();
			spend.record(entry(morning, 60));
			spend.reserve(5);
			expect(spend.dayOver(morning, 60)).not.toBeNull();
			expect(spend.dayOver(morning, 60, 1)).not.toBeNull();
		});
	});

	it('checks the day as it always did when no other Session is running', () => {
		const spend = make();
		spend.record(entry(morning, 59));
		// a Session whose cap passes the limit still starts: only the spend so far counts
		expect(spend.dayOver(morning, 60, 15)).toBeNull();
		const running = spend.reserve(5);
		running.release();
		expect(spend.dayOver(morning, 60, 15)).toBeNull();
		// and once it started, its Session holds even past the limit: a Feature's fix rounds go on as with one Slot
		spend.record(entry(morning, 2));
		expect(typeof spend.hold(15, morning, 60)).toBe('object');
	});
});
