import { describe, expect, it } from 'vitest';
import { retryPassing, RETRY_WAITS_MS, type Failed } from './retry.js';

type Got = { kind: 'done'; sessionId: string; costUsd: number } | (Failed & { sessionId: string });

const failed = (failure: Failed['failure'], why = 'overloaded', costUsd = 1): Got => ({
	kind: 'failed',
	why,
	failure,
	sessionId: 's',
	costUsd
});
const done: Got = { kind: 'done', sessionId: 's', costUsd: 2 };

function bench(
	answers: Got[],
	over: { budgetUsd?: number; enough?: (usd: number) => boolean } = {}
) {
	const waits: number[] = [];
	const resets: number[] = [];
	const recorded: string[] = [];
	const budgets: number[] = [];
	const retrying: number[] = [];
	const run = () =>
		retryPassing<Got>({
			budgetUsd: over.budgetUsd ?? 15,
			enough: over.enough ?? (() => true),
			reset: () => {
				resets.push(waits.length);
				return Promise.resolve();
			},
			sleep: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			},
			run: (usd, attempt) => {
				budgets.push(usd);
				const got = answers[attempt - 1];
				if (got === undefined) throw new Error('no more answers');
				return Promise.resolve(got);
			},
			record: (f, attempt) => recorded.push(`${String(attempt)}:${f.why}`),
			retrying: (attempt) => retrying.push(attempt)
		});
	return { run, waits, resets, recorded, budgets, retrying };
}

describe('retryPassing', () => {
	it('waits 30 seconds, then 2 minutes, and stops at the first answer that is not a passing failure', async () => {
		expect([...RETRY_WAITS_MS]).toEqual([30_000, 120_000]);
		const b = bench([failed('passing'), failed('passing'), done]);
		const got = await b.run();
		expect(got.outcome).toEqual(done);
		expect(b.waits).toEqual([30_000, 120_000]);
		expect(got.earlierUsd).toBe(2);
		expect(b.budgets).toEqual([15, 14, 13]);
	});

	it('resets the worktree before each wait, and records each try that another follows', async () => {
		const b = bench([failed('passing', 'a'), failed('passing', 'b'), done]);
		await b.run();
		expect(b.resets).toEqual([0, 1]);
		expect(b.recorded).toEqual(['1:a', '2:b']);
		expect(b.retrying).toEqual([2, 3]);
	});

	it('ends on the third passing failure, naming every try', async () => {
		const b = bench([failed('passing', 'a'), failed('passing', 'b'), failed('passing', 'c')]);
		const got = await b.run();
		expect(got.outcome).toMatchObject({
			kind: 'failed',
			why: 'try 1: a; try 2: b; try 3: c'
		});
		expect(b.recorded).toEqual(['1:a', '2:b']);
	});

	it.each(['lasting', 'budget'] as const)('does not try a %s failure again', async (kind) => {
		const b = bench([failed(kind)]);
		const got = await b.run();
		expect(got.outcome).toMatchObject({ kind: 'failed', why: 'overloaded' });
		expect(b.waits).toEqual([]);
	});

	it('does not start a try the budget has no room for', async () => {
		const b = bench([failed('passing', 'a', 14.5)], { enough: (usd) => usd >= 1 });
		const got = await b.run();
		expect(got.outcome).toMatchObject({ kind: 'failed', why: 'a' });
		expect(b.waits).toEqual([]);
		expect(b.recorded).toEqual([]);
	});
});
