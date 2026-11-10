// A Feedback round: one Session that answers the trusted feedback on a Feature's open draft pull request, the check and its fix rounds, and one commit whose trailer names what it answered.
import type { RunCheck } from './check.js';
import type { ChangeRequest, CodeHost, Feedback, OpenPull, Pull, PullCommit } from './code-host.js';
import { envOf, type CodingAgent } from './coding-agent.js';
import type { Env } from './git.js';
import type { Allowance, Entry } from './spend.js';
import type { Feature } from './tracker.js';
import { DIFF_CHARS, type FixEnd, type FixWork, type Halt } from './workflow.js';
import { FEEDBACK_ASKED_TRAILER, FEEDBACK_TRAILER, trailersOf, type Worktree } from './worktree.js';

// A piece of feedback the round did not answer, and why.
export interface Unanswered {
	readonly feedback: Feedback;
	readonly why: string;
}

export type FeedbackRoundEnd =
	// no round ran: the Code host reads no feedback, the branch has no open pull request, or all its trusted feedback is answered
	| { readonly kind: 'none' }
	// one commit on the branch, not pushed yet, naming the feedback in `answered`
	| {
			readonly kind: 'answered';
			readonly pull: Pull;
			// the commit's short id, which each reply names
			readonly commit: string;
			readonly answered: readonly { readonly feedback: Feedback; readonly note: string }[];
			readonly left: readonly Unanswered[];
	  }
	// thrown away, the attempt kept on `side` when it left anything
	| {
			readonly kind: 'failed';
			readonly pull: Pull;
			readonly why: string;
			readonly left: readonly Unanswered[];
			readonly side: string | null;
	  }
	| Halt;

type LogEntry = Omit<Entry, 'at' | 'repo' | 'feature' | 'branch'>;

// What the round works with: the run's seams and worktree, and how the run shows, logs and fixes a round.
export interface FeedbackRoundContext {
	readonly codeHost: CodeHost;
	readonly codingAgent: Pick<CodingAgent, 'feedback'>;
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
	readonly tree: Pick<
		Worktree,
		'at' | 'head' | 'diff' | 'discard' | 'answeredFeedback' | 'commitFeedback'
	>;
	// why the day is over, once it is; checked only when there is feedback to answer
	readonly dailyPause: () => string | null;
	readonly allowance: (cap: number, spent: number) => Allowance;
	// the check's fix rounds, in the round's Session
	readonly fix: (work: FixWork) => Promise<FixEnd>;
	readonly log: (entry: LogEntry) => void;
	readonly building: (session: string) => void;
	// the id of the request for changes that started a round with no Go, which its commit names
	readonly asked?: string;
}

const NONE: FeedbackRoundEnd = { kind: 'none' };

// The trusted feedback on the pull request that no Factory-Feedback trailer on the branch names.
async function unanswered(
	codeHost: CodeHost,
	tree: FeedbackRoundContext['tree'],
	pull: Pull
): Promise<Feedback[]> {
	if (codeHost.feedback === undefined) return [];
	const answered = await tree.answeredFeedback();
	// feedback from an author Nightjar does not trust never reaches the Coding agent
	return (await codeHost.feedback(pull)).filter((f) => f.trusted && !answered.has(f.id));
}

export async function feedbackRound(ctx: FeedbackRoundContext): Promise<FeedbackRoundEnd> {
	const { codeHost, tree, feature, setup } = ctx;
	if (codeHost.feedback === undefined || codeHost.reply === undefined) return NONE;
	const pull = await codeHost.openPull(tree.at.branch);
	if (pull === null) return NONE;
	const todo = await unanswered(codeHost, tree, pull);
	if (todo.length === 0) return NONE;
	const day = ctx.dailyPause();
	if (day !== null) return { kind: 'paused', why: day };

	const cap = setup.limits.ticketUsd;
	const before = await tree.head();
	const sessionId = ctx.newId();
	const name = `#${feature.id} Feedback round`;
	ctx.say(`${name}: ${String(todo.length)} unanswered on ${pull.url}, session ${sessionId}`);
	ctx.building(sessionId);
	const got = await ctx.codingAgent.feedback({
		kind: 'feedback',
		at: tree.at,
		sessionId,
		feature,
		feedback: todo,
		diff: await tree.diff(DIFF_CHARS),
		budgetUsd: cap
	});
	const entry = { ticket: null, step: 'feedback' as const, session: got.sessionId };
	const log = (outcome: string, extra: Partial<LogEntry> = {}) =>
		ctx.log({ ...entry, costUsd: got.costUsd, outcome, ...extra });

	// what the Session said of each piece; a piece it left out is not answered
	const said = new Map(got.kind === 'answered' ? got.items.map((i) => [i.id, i]) : []);
	const isAnswered = (f: Feedback) => said.get(f.id)?.answered === true;
	const noteOf = (f: Feedback) => {
		const note = said.get(f.id)?.note.trim() ?? '';
		return note === '' ? 'the Session said nothing of it' : note;
	};
	const failed = async (why: string): Promise<FeedbackRoundEnd> => {
		const side = await tree.discard(before, 'feedback');
		ctx.say(`${name} thrown away: ${why}`);
		// a piece the Session declined keeps its own reason; the rest fall with the round
		const left = todo.map((f) => ({
			feedback: f,
			why: said.has(f.id) && !isAnswered(f) ? noteOf(f) : why
		}));
		return { kind: 'failed', pull, why, left, side };
	};
	const halted = async (halt: Halt): Promise<FeedbackRoundEnd> => {
		await tree.discard(before, 'feedback');
		return halt;
	};

	if (got.kind === 'paused') {
		log(`paused: ${got.why}`);
		return halted(got);
	}
	if (got.kind === 'aborted') {
		log('stopped by a person');
		return halted(got);
	}
	if (got.kind === 'failed') {
		log(`failed: ${got.why}`, { failure: got.failure });
		return failed(got.why);
	}
	if (got.kind === 'blocked') {
		log('blocked');
		return failed(`it reports itself blocked: ${got.blocker}`);
	}
	const yes = todo.filter(isAnswered);
	log(`answered ${String(yes.length)} of ${String(todo.length)}`);
	if (yes.length === 0) return failed('it answered none of the feedback');

	const first = await ctx.runCheck(setup.check, tree.at.folder, envOf(setup));
	const fixed = await ctx.fix({
		ticket: null,
		name,
		sessionId: got.sessionId,
		cap,
		spent: got.costUsd,
		check: first,
		of: { kind: 'feedback' }
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
	const ids = yes.map((f) => f.id);
	const commit = await tree.commitFeedback(ids, summary, got.sessionId, ctx.asked);
	if (commit === null) return failed('it said it answered feedback but changed no file');
	ctx.say(`${name}: ${commit} answers ${ids.join(', ')}`);
	return {
		kind: 'answered',
		pull,
		commit,
		answered: yes.map((f) => ({ feedback: f, note: noteOf(f) })),
		left: todo.filter((f) => !isAnswered(f)).map((f) => ({ feedback: f, why: noteOf(f) }))
	};
}

// The most Feedback rounds a request for changes starts on one pull request; after them only a Go starts another.
export const AUTOMATIC_ROUNDS = 5;

// What a pull request's commits say of its Feedback rounds: when the last one was made, and how many a request for changes started.
export interface FeedbackHistory {
	readonly lastAt: string | null;
	readonly automatic: number;
}

export function feedbackHistory(commits: readonly PullCommit[]): FeedbackHistory {
	const rounds = commits.map((c) => ({ at: c.at, trailers: trailersOf(c.message) }));
	const answered = rounds.filter((c) => c.trailers.has(FEEDBACK_TRAILER));
	return {
		lastAt: answered.at(-1)?.at ?? null,
		automatic: answered.filter((c) => c.trailers.has(FEEDBACK_ASKED_TRAILER)).length
	};
}

// The newest trusted request for changes made after the last Feedback round, or after the pull request opened when it has had none; null when there is none. A time that cannot be read is never later.
export function newRequest(
	open: Pick<OpenPull, 'commits' | 'changesRequested'>
): ChangeRequest | null {
	const { lastAt } = feedbackHistory(open.commits);
	const since = lastAt === null ? -Infinity : Date.parse(lastAt);
	const later = open.changesRequested.filter((r) => r.trusted && Date.parse(r.at) > since);
	return later.at(-1) ?? null;
}

// One piece of feedback as a line of a list: its id, its author, and where it sits.
export function feedbackLine(u: Unanswered): string {
	const f = u.feedback;
	const at =
		f.path === undefined
			? ''
			: ` on \`${f.line === undefined ? f.path : `${f.path}:${String(f.line)}`}\`${f.outdated === true ? ' (an earlier version)' : ''}`;
	return `- \`${f.id}\` by ${f.author}${at}: ${u.why}`;
}

// What a reply to answered feedback says; the Code host adds the footer.
export const replyText = (commit: string, note: string) => `Answered in ${commit}: ${note}`;

// The comment on a Feature whose round was thrown away: the pull request, why, and each piece left unanswered.
export function thrownAwayComment(end: Extract<FeedbackRoundEnd, { kind: 'failed' }>): string {
	const kept = end.side === null ? '' : `\n\nThe attempt is kept on branch \`${end.side}\`.`;
	return `Nightjar could not answer the feedback on ${end.pull.url}: ${end.why}.\n\nLeft unanswered:\n\n${end.left.map(feedbackLine).join('\n')}${kept}`;
}

// The Feedback rounds of a branch, from the ledger: one Session each, its fix rounds resuming it.
export function feedbackRounds(
	entries: readonly Entry[],
	repo: string,
	branch: string
): { readonly rounds: number; readonly usd: number } {
	const ours = entries.filter(
		(e) => e.step === 'feedback' && e.repo === repo && e.branch === branch
	);
	return {
		rounds: new Set(ours.map((e) => e.session)).size,
		usd: ours.reduce((n, e) => n + e.costUsd, 0)
	};
}

// The pull request's Feedback section: every round its branch had, what they cost, and what this run left unanswered.
export function feedbackSection(
	spent: { readonly rounds: number; readonly usd: number },
	left: readonly Unanswered[]
): string {
	const rounds = `${String(spent.rounds)} Feedback round${spent.rounds === 1 ? '' : 's'}`;
	const head = `## Feedback\n\n${rounds} on this branch, $${spent.usd.toFixed(2)}.`;
	return left.length === 0
		? head
		: `${head}\n\nLeft unanswered:\n\n${left.map(feedbackLine).join('\n')}`;
}
