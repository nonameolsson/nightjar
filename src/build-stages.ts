// How each stage of a build went, from its ledger lines: what the Steps bar draws, and what the Logbook can read too.
import { STAGES, stagesOf, type CostLine, type Stage } from './build-cost.js';
import type { Entry } from './spend.js';
import type { Doing } from './status-shape.js';

// passed first time; passed after a retry or a round; failed; running now; not got to yet; never run by this build
export type StageState = 'passed' | 'retried' | 'failed' | 'running' | 'notReached' | 'notNeeded';

export const STATE_TEXT: Readonly<Record<StageState, string>> = {
	passed: 'passed',
	retried: 'passed after a retry or a round',
	failed: 'failed',
	running: 'running',
	notReached: 'not reached',
	notNeeded: 'not needed'
};

// What of a ledger line the stages read.
export type StageLine = CostLine & Pick<Entry, 'outcome' | 'failure'>;

export interface BuildStage {
	readonly stage: Stage;
	readonly state: StageState;
	// the stage's ledger lines, one per Session or fix round, as the cost by stage counts them
	readonly sessions: number;
	readonly usd: number;
}

export interface BuildEnd {
	// how the build ended: a draft pull request, a failure, or not yet
	readonly end: 'pull' | 'failed' | 'building';
	// the stage the build in flight is in; null while it sets up
	readonly running?: Stage | null;
	// the stages the repo's config never runs, such as the Review when it is off
	readonly neverRun?: ReadonlySet<Stage>;
}

// The stages in the order a build reaches them, which is not the order the bar shows: a Feedback round runs after the Steps and before the Review, and a Pull-check fix after the pull request opens.
const IN_TIME: readonly Stage[] = [
	'tickets',
	'steps',
	'feedback',
	'review',
	'reviewRounds',
	'pullChecks'
];

// The stage of the work status.json says is running; null while the build sets up. A fix round with no Ticket is a Step's after all Tickets, as in the cost by stage.
export function runningStage(doing: Pick<Extract<Doing, { kind: 'building' }>, 'step' | 'ticket'>) {
	const of: Readonly<Record<typeof doing.step, Stage | null>> = {
		setup: null,
		build: 'tickets',
		fix: doing.ticket === null ? 'steps' : 'tickets',
		step: 'steps',
		review: 'review',
		reviewRound: 'reviewRounds',
		pullChecks: 'pullChecks',
		feedback: 'feedback'
	};
	return of[doing.step];
}

// A line whose Session did not end well: it failed, gave up, was blocked, paused or stopped, or asked questions.
const BAD =
	/(?:^|: )(?:failed|blocked|stopped by a person|paused)\b|\bfailed: |gave up$|^questions\b|^answered 0 of /;

// The round a line's outcome names, as `round 2` or `pull checks 2`; 1 when it names none.
function roundOf(outcome: string): number {
	const found = /\bround (\d+)\b/.exec(outcome) ?? /^pull checks (\d+)\b/.exec(outcome);
	return found === null ? 1 : Number(found[1]);
}

// How a stage that has lines went, read from them in order.
function stateOf(stage: Stage, lines: readonly StageLine[]): 'passed' | 'retried' | 'failed' {
	let retried = false;
	for (const [i, line] of lines.entries()) {
		if (line.failure === 'passing') {
			// tried again when a later line of the stage is the same Ticket's work; the last try of all failed
			const again = lines.slice(i + 1).some((l) => l.ticket === line.ticket);
			if (!again) return 'failed';
			retried = true;
			continue;
		}
		if (line.failure !== undefined || BAD.test(line.outcome)) return 'failed';
		if (line.step === 'fix' || roundOf(line.outcome) > 1) retried = true;
	}
	// a Review that ran again, or a second Review round, Feedback round or Pull-check fix, needed a round
	const sessions = new Set(
		lines.filter((l) => l.step !== 'fix' && l.failure !== 'passing').map((l) => l.session)
	);
	if (stage !== 'tickets' && stage !== 'steps' && sessions.size > 1) retried = true;
	return retried ? 'retried' : 'passed';
}

// Each stage of one build, in the bar's order, from the build's ledger lines in the order they were written.
// A stage with no line is not needed when the config never runs it, or the build went past it or ended with a pull request; else it is not reached.
export function buildStages(lines: readonly StageLine[], how: BuildEnd): BuildStage[] {
	const of = stagesOf(lines);
	const own = (stage: Stage) => lines.filter((_, i) => of[i] === stage);
	const running = how.end === 'building' ? (how.running ?? null) : null;
	const reached = IN_TIME.filter((s) => s === running || own(s).length > 0);
	const furthest = Math.max(-1, ...reached.map((s) => IN_TIME.indexOf(s)));
	return STAGES.map((stage): BuildStage => {
		const mine = own(stage);
		const usd = mine.reduce((n, l) => n + l.costUsd, 0);
		const at = (state: StageState) => ({ stage, state, sessions: mine.length, usd });
		if (stage === running) return at('running');
		if (mine.length > 0) return at(stateOf(stage, mine));
		if (how.neverRun?.has(stage) === true || how.end === 'pull') return at('notNeeded');
		return at(IN_TIME.indexOf(stage) < furthest ? 'notNeeded' : 'notReached');
	});
}

// The stages a repo's config never runs: Steps when no Workflow has one, the Review and its rounds when it is off, its rounds when it has none, and Pull checks unless they are on.
export function neverRun(config: {
	readonly workflows?: Readonly<Record<string, { readonly steps: readonly unknown[] }>>;
	readonly review?: { readonly enabled?: boolean; readonly fixRounds?: number };
	readonly pullChecks?: { readonly enabled?: boolean };
}): ReadonlySet<Stage> {
	const never = new Set<Stage>();
	if (Object.values(config.workflows ?? {}).every((w) => w.steps.length === 0)) never.add('steps');
	if (config.review?.enabled === false) never.add('review').add('reviewRounds');
	if (config.review?.fixRounds === 0) never.add('reviewRounds');
	if (config.pullChecks?.enabled !== true) never.add('pullChecks');
	return never;
}
