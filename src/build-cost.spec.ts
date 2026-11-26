import { describe, expect, it } from 'vitest';
import { buildCost, byModel, stagesOf, type CostLine } from './build-cost.js';
import type { ModelUsage } from './spend.js';

const use = (model: string, costUsd: number, tokens = 100): ModelUsage => ({
	model,
	inputTokens: tokens,
	outputTokens: tokens / 10,
	cacheReadTokens: tokens * 10,
	cacheWriteTokens: tokens / 2,
	costUsd
});

const line = (
	step: CostLine['step'],
	session: string,
	costUsd: number,
	more: Partial<CostLine> = {}
): CostLine => ({ ticket: '2', step, session, costUsd, ...more });

describe('the stages of a build', () => {
	it('gives each kind of work its stage, in the order the lines were written', () => {
		const lines = [
			line('build', 'a', 1),
			line('step', 'b', 1),
			line('review', 'c', 1, { ticket: null }),
			line('reviewRound', 'd', 1, { ticket: null }),
			line('pullChecks', 'e', 1, { ticket: null }),
			line('feedback', 'f', 1, { ticket: null })
		];
		expect(stagesOf(lines)).toEqual([
			'tickets',
			'steps',
			'review',
			'reviewRounds',
			'pullChecks',
			'feedback'
		]);
	});

	it('puts a fix round with the work whose Session it resumes, a Step after a Ticket too', () => {
		const lines = [
			line('build', 'a', 3),
			line('fix', 'a', 1),
			line('step', 'b', 1),
			line('fix', 'b', 1),
			line('step', 'c', 2, { ticket: null }),
			line('fix', 'c', 1, { ticket: null })
		];
		expect(stagesOf(lines)).toEqual(['tickets', 'tickets', 'steps', 'steps', 'steps', 'steps']);
	});

	it('files a fix round whose Session it has not seen under the Ticket, or with no Ticket under Steps', () => {
		// the build ran before the window the lines were read for
		expect(stagesOf([line('fix', 'x', 1), line('fix', 'y', 1, { ticket: null })])).toEqual([
			'tickets',
			'steps'
		]);
	});
});

describe('the cost of a build', () => {
	it('sums each stage that ran, in the build loop order, with its Sessions', () => {
		const cost = buildCost([
			line('review', 'r', 0.5, { ticket: null }),
			line('build', 'a', 3),
			// a try that failed for a passing reason, then the one that built
			line('build', 'b', 0.25, { ticket: '3' }),
			line('build', 'b2', 2, { ticket: '3' }),
			line('fix', 'b2', 1, { ticket: '3' }),
			line('reviewRound', 'rr', 2, { ticket: null })
		]);
		expect(cost.usd).toBe(8.75);
		expect(cost.stages).toEqual([
			{ stage: 'tickets', usd: 6.25, sessions: 4 },
			{ stage: 'review', usd: 0.5, sessions: 1 },
			{ stage: 'reviewRounds', usd: 2, sessions: 1 }
		]);
	});

	it('sums each model over the lines, the dearest first, with its tokens', () => {
		const cost = buildCost([
			line('build', 'a', 3, { models: [use('small', 0.5), use('big', 2.5)] }),
			line('review', 'r', 1, { ticket: null, models: [use('big', 1, 200)] })
		]);
		expect(cost.models).toEqual([
			{
				model: 'big',
				inputTokens: 300,
				outputTokens: 30,
				cacheReadTokens: 3000,
				cacheWriteTokens: 150,
				costUsd: 3.5
			},
			use('small', 0.5)
		]);
		expect(cost.unrecorded).toEqual({ sessions: 0, usd: 0 });
	});

	it('reads older lines, which name no model, as stages only, and counts what they cost', () => {
		const cost = buildCost([
			line('build', 'a', 3),
			line('review', 'r', 0.5, { ticket: null, models: [use('big', 0.5)] })
		]);
		expect(cost.stages.map((s) => s.stage)).toEqual(['tickets', 'review']);
		expect(cost.models.map((m) => m.model)).toEqual(['big']);
		expect(cost.unrecorded).toEqual({ sessions: 1, usd: 3 });

		const old = buildCost([line('build', 'a', 3)]);
		expect(old.models).toEqual([]);
		expect(old.unrecorded).toEqual({ sessions: 1, usd: 3 });
	});

	it('gives a build with no lines yet no stages and no models', () => {
		expect(buildCost([])).toEqual({
			usd: 0,
			stages: [],
			models: [],
			unrecorded: { sessions: 0, usd: 0 }
		});
		expect(byModel([])).toEqual([]);
	});
});
