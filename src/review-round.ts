// A Review round: one Session that fixes the issues the last Review found on a complete Feature, the check and its fix rounds, and one commit with a Factory-Review trailer.
import type { RunCheck } from './check.js';
import { envOf, type CodingAgent } from './coding-agent.js';
import type { Env } from './git.js';
import type { Declined, Review } from './prompt.js';
import type { Allowance, LogEntry } from './spend.js';
import type { Feature } from './tracker.js';
import { DIFF_CHARS, type FixEnd, type FixWork, type Halt } from './workflow.js';
import type { Worktree } from './worktree.js';

export type ReviewRoundEnd =
	// one commit on the branch, not pushed yet; none when the round declined every issue and changed no file
	| { readonly kind: 'fixed'; readonly summary: string; readonly declined: readonly Declined[] }
	// thrown away, the attempt kept on `side` when it left anything
	| { readonly kind: 'failed'; readonly why: string; readonly side: string | null }
	| Halt;

// What the round works with: the run's seams and worktree, and how the run shows, logs and fixes a round.
export interface ReviewRoundContext {
	readonly codingAgent: Pick<CodingAgent, 'reviewRound'>;
	readonly runCheck: RunCheck;
	readonly newId: () => string;
	readonly say: (line: string) => void;
	readonly setup: {
		readonly check: string;
		readonly env: Env;
		readonly portEnv?: Readonly<Record<string, string>>;
		// a round runs on a Ticket's budget
		readonly limits: { readonly ticketUsd: number };
	};
	readonly feature: Feature;
	readonly tree: Pick<Worktree, 'at' | 'head' | 'diff' | 'discard' | 'commitReview'>;
	// the round of the build this is, from 1
	readonly round: number;
	// what the last Review asked to change
	readonly issues: Review['issues'];
	// the issues earlier rounds of the build declined, each with its reason
	readonly declined: readonly Declined[];
	// "note": the Feature's Workflow writes a note, so the round may revise only the note
	readonly output?: 'note';
	// why the day is over, once it is
	readonly dailyPause: (cap: number) => string | null;
	readonly allowance: (cap: number, spent: number) => Allowance;
	// the check's fix rounds, in the round's Session
	readonly fix: (work: FixWork) => Promise<FixEnd>;
	readonly log: (entry: LogEntry) => void;
	readonly building: (session: string) => void;
}

export async function reviewRound(ctx: ReviewRoundContext): Promise<ReviewRoundEnd> {
	const { tree, feature, setup } = ctx;
	const day = ctx.dailyPause(setup.limits.ticketUsd);
	if (day !== null) return { kind: 'paused', why: day };

	const cap = setup.limits.ticketUsd;
	const before = await tree.head();
	const sessionId = ctx.newId();
	const name = `#${feature.id} Review round ${String(ctx.round)}`;
	ctx.say(`${name}: ${String(ctx.issues.length)} issues, session ${sessionId}`);
	ctx.building(sessionId);
	const got = await ctx.codingAgent.reviewRound({
		kind: 'reviewRound',
		at: tree.at,
		sessionId,
		feature,
		issues: ctx.issues,
		declined: ctx.declined,
		diff: await tree.diff(DIFF_CHARS),
		...(ctx.output === undefined ? {} : { output: ctx.output }),
		budgetUsd: cap
	});
	const log = (outcome: string, extra: Partial<LogEntry> = {}) =>
		ctx.log({
			ticket: null,
			step: 'reviewRound',
			session: got.sessionId,
			costUsd: got.costUsd,
			outcome,
			...extra
		});
	const failed = async (why: string): Promise<ReviewRoundEnd> => {
		const side = await tree.discard(before, 'review');
		ctx.say(`${name} thrown away: ${why}`);
		return { kind: 'failed', why, side };
	};
	const halted = async (halt: Halt): Promise<ReviewRoundEnd> => {
		await tree.discard(before, 'review');
		return halt;
	};

	switch (got.kind) {
		case 'paused':
			log(`paused: ${got.why}`);
			return halted(got);
		case 'aborted':
			log('stopped by a person');
			return halted(got);
		case 'failed':
			log(`failed: ${got.why}`, { failure: got.failure });
			return failed(got.why);
		case 'blocked':
			log('blocked');
			return failed(`it reports itself blocked: ${got.blocker}`);
		case 'fixed':
			log('fixed');
	}

	const first = await ctx.runCheck(setup.check, tree.at.folder, envOf(setup));
	const fixed = await ctx.fix({
		ticket: null,
		name,
		sessionId: got.sessionId,
		cap,
		spent: got.costUsd,
		check: first,
		of: { kind: 'reviewRound', ...(ctx.output === undefined ? {} : { output: ctx.output }) }
	});
	if (fixed.halt !== undefined) return halted(fixed.halt);
	if (!fixed.check.ok) {
		return failed(
			ctx.allowance(cap, fixed.spent).enough
				? `\`${setup.check}\` still fails after the fix rounds`
				: `it reached its cap of $${cap.toFixed(2)}`
		);
	}
	const summary = [got.summary, ...fixed.summaries].join('\n\n');
	const { declined } = got;
	if (!(await tree.commitReview(ctx.round, summary, got.sessionId))) {
		// a round that declines every issue has nothing to change: the Review is wrong, not the round
		if (declined.length < ctx.issues.length) {
			return failed('it said it fixed the issues but changed no file');
		}
		ctx.say(`${name}: declined every issue`);
		return { kind: 'fixed', summary, declined };
	}
	ctx.say(`${name}: committed`);
	return { kind: 'fixed', summary, declined };
}
