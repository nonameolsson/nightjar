// What a build cost, split by the stages of the build loop and by the models its Sessions ran on, from its ledger lines.
import type { Entry, ModelUsage } from './spend.js';

// A stage of the build loop.
export type Stage = 'tickets' | 'steps' | 'review' | 'reviewRounds' | 'pullChecks' | 'feedback';

// The stages in the build loop's order; a stage before the Tickets goes first.
export const STAGES: readonly Stage[] = [
	'tickets',
	'steps',
	'review',
	'reviewRounds',
	'pullChecks',
	'feedback'
];

export const STAGE_TEXT: Readonly<Record<Stage, string>> = {
	tickets: 'Tickets',
	steps: 'Steps',
	review: 'Review',
	reviewRounds: 'Review rounds',
	pullChecks: 'Pull checks',
	feedback: 'Feedback'
};

// What of a ledger line the split reads.
export type CostLine = Pick<Entry, 'ticket' | 'step' | 'session' | 'costUsd' | 'models'>;

const OWN: Readonly<Record<Exclude<Entry['step'], 'fix'>, Stage>> = {
	build: 'tickets',
	step: 'steps',
	review: 'review',
	reviewRound: 'reviewRounds',
	pullChecks: 'pullChecks',
	feedback: 'feedback'
};

// The stage of each line, in order. A fix round belongs to the work whose Session it resumes; one whose Session the lines do not hold is a Ticket's, or with no Ticket a Step's after all Tickets.
export function stagesOf(lines: readonly CostLine[]): Stage[] {
	const bySession = new Map<string, Stage>();
	return lines.map((line) => {
		const stage =
			line.step === 'fix'
				? (bySession.get(line.session) ?? (line.ticket === null ? 'steps' : 'tickets'))
				: OWN[line.step];
		if (line.step !== 'fix') bySession.set(line.session, stage);
		return stage;
	});
}

export interface StageCost {
	readonly stage: Stage;
	readonly usd: number;
	// the ledger lines of the stage, one per Session or fix round, as the Logbook counts them
	readonly sessions: number;
}

export interface BuildCost {
	readonly usd: number;
	// the stages that ran, in the build loop's order
	readonly stages: readonly StageCost[];
	// each model the lines name, summed, the dearest first
	readonly models: readonly ModelUsage[];
	// the lines that did not record their models: older lines, or a Session that reported none
	readonly unrecorded: { readonly sessions: number; readonly usd: number };
}

// Each model's tokens and dollars over the lines, the dearest first.
export function byModel(lines: readonly Pick<CostLine, 'models'>[]): ModelUsage[] {
	const sums = new Map<string, ModelUsage>();
	for (const used of lines.flatMap((l) => l.models ?? [])) {
		const was = sums.get(used.model);
		sums.set(
			used.model,
			was === undefined
				? { ...used }
				: {
						model: used.model,
						inputTokens: was.inputTokens + used.inputTokens,
						outputTokens: was.outputTokens + used.outputTokens,
						cacheReadTokens: was.cacheReadTokens + used.cacheReadTokens,
						cacheWriteTokens: was.cacheWriteTokens + used.cacheWriteTokens,
						costUsd: was.costUsd + used.costUsd
					}
		);
	}
	return [...sums.values()].sort((a, b) => b.costUsd - a.costUsd);
}

// One build's cost, from its ledger lines in the order they were written.
export function buildCost(lines: readonly CostLine[]): BuildCost {
	const stages = stagesOf(lines);
	const split = STAGES.flatMap((stage): StageCost[] => {
		const own = lines.filter((_, i) => stages[i] === stage);
		return own.length === 0
			? []
			: [{ stage, usd: own.reduce((n, l) => n + l.costUsd, 0), sessions: own.length }];
	});
	const bare = lines.filter((l) => l.models === undefined);
	return {
		usd: lines.reduce((n, l) => n + l.costUsd, 0),
		stages: split,
		models: byModel(lines),
		unrecorded: { sessions: bare.length, usd: bare.reduce((n, l) => n + l.costUsd, 0) }
	};
}
