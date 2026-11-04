// Starts a Session for one piece of work and says how it ended; what the Coding agent is told and allowed lives here.
import { join, relative } from 'node:path';
import type { Env } from './git.js';
import {
	BUILD_SCHEMA,
	REVIEW_SCHEMA,
	STEP_SCHEMA,
	buildPrompt,
	fixPrompt,
	pullChecksPrompt,
	readBuildAnswer,
	readReview,
	readStepAnswer,
	reviewPrompt,
	stepPrompt,
	stepRoundPrompt,
	type Question,
	type Review
} from './prompt.js';
import type { Session, SessionRequest, SessionResult } from './session.js';
import {
	BUILD_TOOLS,
	REVIEW_TOOLS,
	buildSettings,
	reviewSettings,
	stepTools,
	type StepExtras
} from './settings.js';
import type { Comment, Feature, Ticket } from './tracker.js';
import type { StepConfig } from './workflow.js';
import type { FeatureBranch } from './worktree.js';

// A model and effort, each named or left to the next in line.
export interface ModelEffort {
	readonly model?: string;
	readonly effort?: string;
}

// What of the run's setup a Session needs.
export interface AgentSetup {
	// the main checkout, which holds .factory/
	readonly root: string;
	readonly check: string;
	readonly allowedCommands: readonly string[];
	readonly rules?: string;
	readonly plugins?: readonly string[];
	readonly portEnv?: Readonly<Record<string, string>>;
	readonly allowApiKey: boolean;
	readonly env: Env;
	// --model and --effort: they win over the work's own setting and over the defaults
	readonly model?: string;
	readonly effort?: string;
	readonly defaults?: ModelEffort;
	readonly review?: ModelEffort;
	readonly limits: {
		readonly ticketMinutes: number;
		readonly reviewMinutes: number;
		readonly fixRounds: number;
	};
	readonly signal?: AbortSignal;
}

// What every session and command of the run sees: the machine's environment and the reserved ports.
export const envOf = (setup: Pick<AgentSetup, 'env' | 'portEnv'>): Env => ({
	...setup.env,
	...setup.portEnv
});

export const logsPath = (root: string) => join(root, '.factory', 'logs');

// A Ticket's own `**Model:**` and `**Effort:**` lines.
export function ticketLine(body: string, name: string): string | undefined {
	const match = new RegExp(`^(?:\\*\\*)?${name}:(?:\\*\\*)?\\s*(\\S+)`, 'im').exec(body);
	return match?.[1]?.toLowerCase();
}

// What every request carries: the Feature's worktree, and what is left of the work's budget.
interface Work {
	readonly at: FeatureBranch;
	readonly budgetUsd: number;
}

export interface BuildRequest extends Work {
	readonly kind: 'build';
	readonly sessionId: string;
	readonly feature: Feature;
	readonly ticket: Ticket;
	// only Trusted comments
	readonly featureComments: readonly Comment[];
	readonly ticketComments: readonly Comment[];
	readonly built: readonly { readonly id: string; readonly title: string }[];
}

// A Step's fix rounds run with the Step's own extras and model, so a fix can do what the Step could; a Pull-check fix runs as the build it fixes.
export type Fixing =
	| { readonly kind: 'build' }
	| { readonly kind: 'step'; readonly step: StepConfig; readonly extras: StepExtras }
	| { readonly kind: 'pullChecks' };

export interface FixRequest extends Work {
	readonly kind: 'fix';
	readonly of: Fixing;
	// the Session of the work it fixes
	readonly resume: string;
	readonly round: number;
	// the failing check's output; for a Pull-check fix, the failed Pull checks in the gate report's shape
	readonly tail: string;
}

export interface StepRequest extends Work {
	readonly kind: 'step';
	readonly sessionId: string;
	readonly workflow: string;
	readonly step: StepConfig;
	readonly extras: StepExtras;
	readonly round: number;
	readonly rounds: number;
	readonly feature: Feature;
	// the Ticket an afterEachTicket Step runs after
	readonly ticket: Ticket | null;
	// the notes folder every Step of the run shares
	readonly notes: string;
	readonly diff?: { readonly text: string; readonly truncated: boolean };
	// what the last round left to do
	readonly left: readonly string[];
}

export interface ReviewRequest extends Work {
	readonly kind: 'review';
	readonly sessionId: string;
	readonly feature: Feature;
	readonly tickets: readonly Ticket[];
}

// How any Session can end besides its answer.
export type Ended =
	| { readonly kind: 'failed'; readonly why: string }
	// a reason of the machine or the plan: the run goes on later
	| { readonly kind: 'paused'; readonly why: string }
	| { readonly kind: 'aborted' };

type Outcome<T> = (T | Ended) & { readonly sessionId: string; readonly costUsd: number };

export type BuildOutcome = Outcome<
	| { readonly kind: 'built'; readonly summary: string }
	| { readonly kind: 'questions'; readonly questions: readonly Question[] }
>;

export type FixOutcome = Outcome<
	{ readonly kind: 'fixed'; readonly summary: string } | { readonly kind: 'gaveUp' }
>;

export type StepOutcome = Outcome<
	| {
			readonly kind: 'done';
			readonly summary: string;
			readonly left: readonly string[];
			readonly untilHolds: boolean;
	  }
	| { readonly kind: 'blocked'; readonly blocker: string }
>;

export type ReviewOutcome = Outcome<{ readonly kind: 'reviewed'; readonly review: Review }>;

export interface CodingAgent {
	build(req: BuildRequest): Promise<BuildOutcome>;
	fix(req: FixRequest): Promise<FixOutcome>;
	step(req: StepRequest): Promise<StepOutcome>;
	review(req: ReviewRequest): Promise<ReviewOutcome>;
}

const API_KEY_PAUSE =
	'the session billed an API key; unset ANTHROPIC_API_KEY or pass --use-api-key';

const limitPause = (resetsAt: number | null) =>
	`the plan's usage limit was reached${resetsAt ? `; it resets at ${new Date(resetsAt * 1000).toISOString()}` : ''}`;

// Why a session that could not go on pauses the run.
const pauseWhy = (
	result:
		| { readonly kind: 'api-key' }
		| { readonly kind: 'rate-limited'; readonly resetsAt: number | null }
) => (result.kind === 'api-key' ? API_KEY_PAUSE : limitPause(result.resetsAt));

export function codingAgent(setup: AgentSetup, session: Session): CodingAgent {
	// A CLI flag, then the work's own setting, then the repo's defaults.
	const pick = (own: ModelEffort = {}): ModelEffort => ({
		model: setup.model ?? own.model ?? setup.defaults?.model,
		effort: setup.effort ?? own.effort ?? setup.defaults?.effort
	});

	const request = (
		work: Work,
		over: Pick<SessionRequest, 'prompt' | 'sessionId'> & Partial<SessionRequest>
	): SessionRequest => ({
		cwd: work.at.folder,
		schema: BUILD_SCHEMA,
		tools: BUILD_TOOLS,
		settings: buildSettings(setup.allowedCommands),
		budgetUsd: work.budgetUsd,
		minutes: setup.limits.ticketMinutes,
		log: join(logsPath(setup.root), `${over.sessionId}.jsonl`),
		plugins: (setup.plugins ?? []).map((p) => join(work.at.folder, p)),
		allowApiKey: setup.allowApiKey,
		env: envOf(setup),
		signal: setup.signal,
		...over
	});

	// Starts one Session and says what its end means; `read` is null for an answer in a shape not known.
	async function outcomeOf<T>(
		req: SessionRequest,
		read: (output: unknown) => T | null
	): Promise<Outcome<T>> {
		const result: SessionResult = await session(req);
		const ended = {
			sessionId: result.sessionId,
			costUsd: 'costUsd' in result ? result.costUsd : 0
		};
		if (setup.signal?.aborted === true) return { kind: 'aborted', ...ended };
		if (result.kind === 'api-key' || result.kind === 'rate-limited') {
			return { kind: 'paused', why: pauseWhy(result), ...ended };
		}
		if (result.kind === 'stopped') return { kind: 'failed', why: result.why, ...ended };
		const answer = read(result.output);
		if (answer === null) {
			return { kind: 'failed', why: 'it answered in a shape not known', ...ended };
		}
		return { ...answer, ...ended };
	}

	const build = (req: BuildRequest) =>
		outcomeOf(
			request(req, {
				prompt: buildPrompt({
					feature: req.feature,
					ticket: req.ticket,
					featureComments: req.featureComments,
					ticketComments: req.ticketComments,
					built: req.built,
					allowed: setup.allowedCommands,
					check: setup.check,
					rules: setup.rules
				}),
				sessionId: req.sessionId,
				...pick({
					model: ticketLine(req.ticket.body, 'Model'),
					effort: ticketLine(req.ticket.body, 'Effort')
				})
			}),
			(output) => {
				const answer = readBuildAnswer(output);
				if (answer === null) return null;
				return answer.outcome === 'built'
					? { kind: 'built' as const, summary: answer.summary }
					: { kind: 'questions' as const, questions: answer.questions };
			}
		);

	// What a Step's Session runs under, its fix rounds too.
	const stepSession = (step: StepConfig, extras: StepExtras) => ({
		schema: STEP_SCHEMA,
		tools: stepTools(extras),
		settings: buildSettings(setup.allowedCommands, extras),
		...pick(step)
	});

	// A build's fix round keeps the model the Session was resumed on: it names none.
	const fix = (req: FixRequest) =>
		outcomeOf(
			request(req, {
				prompt:
					req.of.kind === 'pullChecks'
						? pullChecksPrompt(setup.check, req.tail)
						: fixPrompt(req.round, setup.limits.fixRounds, setup.check, req.tail),
				sessionId: req.resume,
				resume: req.resume,
				...(req.of.kind === 'step' ? stepSession(req.of.step, req.of.extras) : {})
			}),
			(output) => {
				if (req.of.kind !== 'step') {
					const answer = readBuildAnswer(output);
					if (answer === null) return null;
					return answer.outcome === 'built'
						? { kind: 'fixed' as const, summary: answer.summary }
						: { kind: 'gaveUp' as const };
				}
				const answer = readStepAnswer(output);
				if (answer === null) return null;
				return answer.outcome === 'done'
					? { kind: 'fixed' as const, summary: answer.summary }
					: { kind: 'gaveUp' as const };
			}
		);

	// A Step without an `until` runs one round, on its first prompt.
	const step = (req: StepRequest) =>
		outcomeOf(
			request(req, {
				prompt:
					req.round === 1 || req.step.until === undefined
						? stepPrompt({
								workflow: req.workflow,
								step: req.step,
								rounds: req.rounds,
								feature: req.feature,
								...(req.ticket === null ? {} : { ticket: req.ticket }),
								allowed: [...setup.allowedCommands, ...(req.extras.allowedCommands ?? [])],
								check: setup.check,
								...(setup.rules === undefined ? {} : { rules: setup.rules }),
								notes: relative(req.at.folder, req.notes),
								base: req.at.base,
								...(req.diff === undefined ? {} : { diff: req.diff })
							})
						: stepRoundPrompt(req.round, req.rounds, req.step.until, req.left),
				sessionId: req.sessionId,
				...(req.round > 1 ? { resume: req.sessionId } : {}),
				...stepSession(req.step, req.extras)
			}),
			(output) => {
				const answer = readStepAnswer(output);
				if (answer === null) return null;
				return answer.outcome === 'done'
					? {
							kind: 'done' as const,
							summary: answer.summary,
							left: answer.left,
							untilHolds: req.step.until === undefined || answer.untilHolds
						}
					: { kind: 'blocked' as const, blocker: answer.blocker };
			}
		);

	return {
		build,
		fix,
		step,
		review: (req) =>
			outcomeOf(
				request(req, {
					prompt: reviewPrompt(req.feature, req.at.base, req.tickets, setup.rules),
					sessionId: req.sessionId,
					schema: REVIEW_SCHEMA,
					tools: REVIEW_TOOLS,
					settings: reviewSettings(),
					minutes: setup.limits.reviewMinutes,
					...pick(setup.review)
				}),
				(output) => {
					const review = readReview(output);
					return review === null ? null : { kind: 'reviewed' as const, review };
				}
			)
	};
}
