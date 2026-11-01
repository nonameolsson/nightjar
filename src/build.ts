// The build loop: one Feature from the Go to a draft pull request, through the Tracker and Code host seams alone.
import { join } from 'node:path';
import type { RunCheck } from './check.js';
import type { CodeHost, Pull } from './code-host.js';
import type { Env } from './git.js';
import { record, spentOn, type Entry } from './ledger.js';
import { DEFAULT_DAILY_USD } from './person-config.js';
import { nextTicket, waiting, type Waiting } from './plan.js';
import {
	BUILD_SCHEMA,
	REVIEW_SCHEMA,
	buildPrompt,
	fixPrompt,
	questionRounds,
	questionsComment,
	readBuildAnswer,
	readReview,
	reviewPrompt,
	type Question,
	type Review
} from './prompt.js';
import type { Session, SessionRequest } from './session.js';
import { BUILD_TOOLS, REVIEW_TOOLS, buildSettings, reviewSettings } from './settings.js';
import type { Signal } from './signals.js';
import type { StatusReport } from './status.js';
import type { Comment, Feature, ItemId, Ticket, Tracker } from './tracker.js';
import { branchFor, openWorktree, type Worktree } from './worktree.js';

export interface Limits {
	readonly ticketUsd: number;
	readonly ticketMinutes: number;
	readonly fixRounds: number;
	readonly reviewUsd: number;
	readonly reviewMinutes: number;
	readonly questionRounds: number;
	readonly dailyUsd: number;
}

export const LIMITS: Limits = {
	ticketUsd: 15,
	ticketMinutes: 60,
	fixRounds: 3,
	reviewUsd: 3,
	reviewMinutes: 10,
	questionRounds: 2,
	dailyUsd: DEFAULT_DAILY_USD
};

export interface Deps {
	readonly tracker: Tracker;
	readonly codeHost: CodeHost;
	readonly session: Session;
	readonly runCheck: RunCheck;
	// the worktree setup command, run through the same shell as the check
	readonly runSetup: RunCheck;
	readonly now: () => Date;
	readonly newId: () => string;
	readonly say: (line: string) => void;
	readonly status: StatusReport;
}

export interface Setup {
	// the main checkout, which holds .factory/
	readonly root: string;
	// what the ledger names the repo by
	readonly repo: string;
	readonly worktrees: string;
	readonly baseBranch: string;
	// factory.json's check and allowedCommands
	readonly check: string;
	readonly allowedCommands: readonly string[];
	// the text of factory.json's rules file, added to the build and review prompts
	readonly rules?: string;
	// factory.json's setup: run once in each new worktree, before the first session
	readonly setupCommand?: string;
	// the reserved ports as environment variables, held by the run for its whole life
	readonly portEnv?: Readonly<Record<string, string>>;
	readonly allowApiKey: boolean;
	readonly env: Env;
	// --model and --effort: they win over a Ticket's lines and over the defaults
	readonly model?: string;
	readonly effort?: string;
	// factory.json's model and effort: what a Ticket without its own lines runs on
	readonly defaults?: { readonly model?: string; readonly effort?: string };
	// factory.json's review settings; the review is on when it says nothing
	readonly review?: {
		readonly enabled?: boolean;
		readonly model?: string;
		readonly effort?: string;
	};
	readonly limits: Limits;
	readonly signal?: AbortSignal;
}

export type FeatureOutcome =
	| {
			readonly kind: 'pull';
			readonly pull: Pull;
			readonly built: ItemId[];
			readonly waiting: Waiting[];
	  }
	| { readonly kind: 'nothing'; readonly waiting: Waiting[] }
	// the run stopped for a reason of the machine or the plan, not of the Feature; it goes on later
	| { readonly kind: 'paused'; readonly why: string }
	| { readonly kind: 'stopped' };

// What every session and command of the run sees: the machine's environment and the reserved ports.
const envOf = (setup: Setup): Env => ({ ...setup.env, ...setup.portEnv });

export const ledgerPath = (root: string) => join(root, '.factory', 'runs.jsonl');
const logsPath = (root: string) => join(root, '.factory', 'logs');

export const FOOTER = '\n\n---\n_Built by Nightjar._';

// A Ticket's own `**Model:**` and `**Effort:**` lines.
export function ticketLine(body: string, name: string): string | undefined {
	const match = new RegExp(`^(?:\\*\\*)?${name}:(?:\\*\\*)?\\s*(\\S+)`, 'im').exec(body);
	return match?.[1]?.toLowerCase();
}

const dollars = (n: number) => `$${n.toFixed(2)}`;
const hash = (id: ItemId) => `#${id}`;

type LogEntry = Omit<Entry, 'at' | 'repo' | 'feature' | 'branch'>;

// What building one Ticket left the run to do next.
type Step =
	| { readonly kind: 'next' }
	| { readonly kind: 'paused'; readonly why: string }
	| { readonly kind: 'aborted' }
	| { readonly kind: 'red'; readonly tail: string };

const NEXT: Step = { kind: 'next' };

export async function buildFeature(deps: Deps, setup: Setup, id: ItemId): Promise<FeatureOutcome> {
	const { tracker } = deps;
	const feature = await tracker.feature(id);
	const branch = branchFor(feature.id, feature.title);
	deps.say(`${hash(id)} ${feature.title}: building on ${branch}`);
	await tracker.addSignal(id, 'working');
	await tracker.removeSignal(id, 'go');
	deps.status.doing({
		kind: 'building',
		feature: id,
		ticket: null,
		step: 'setup',
		round: null,
		rounds: null,
		session: null,
		startedAt: deps.now().toISOString()
	});
	const tickets = await tracker.tickets(id);
	const tree = await openWorktree(setup.root, setup.worktrees, branch, setup.baseBranch, setup.env);
	const built = await tree.built();
	if (setup.setupCommand !== undefined && !(await tree.isSetUp())) {
		const command = setup.setupCommand;
		deps.say(`${hash(id)}: setup: ${command}`);
		const got = await deps.runSetup(command, tree.at.folder, envOf(setup));
		if (!got.ok) return setupFailed(deps, id, command, got.tail, waiting(tickets, built));
		await tree.markSetUp();
	}
	const run = new FeatureRun(deps, setup, feature, tree, tickets, built);
	return run.build();
}

// The next run sets the worktree up again.
async function setupFailed(
	deps: Deps,
	id: ItemId,
	command: string,
	tail: string,
	left: Waiting[]
): Promise<FeatureOutcome> {
	const why = `the setup command \`${command}\` failed`;
	deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why });
	await deps.tracker.removeSignal(id, 'working');
	await deps.tracker.addSignal(id, 'needsInfo');
	await deps.tracker.comment(
		id,
		`Nightjar built nothing: ${why} in the worktree.\n\n\`\`\`\n${tail}\n\`\`\`${FOOTER}`
	);
	return { kind: 'nothing', waiting: left };
}

class FeatureRun {
	private spent = 0;
	private featureComments: Comment[] = [];

	constructor(
		private readonly deps: Deps,
		private readonly setup: Setup,
		private readonly feature: Feature,
		private readonly tree: Worktree,
		private readonly tickets: Ticket[],
		private readonly built: Set<ItemId>
	) {}

	private get aborted() {
		return this.setup.signal?.aborted === true;
	}

	async build(): Promise<FeatureOutcome> {
		this.featureComments = await this.trusted(this.feature.id);
		let last: Step = NEXT;
		while (last.kind === 'next' && !this.aborted) {
			const today = spentOn(ledgerPath(this.setup.root), this.deps.now());
			if (today >= this.setup.limits.dailyUsd) {
				last = {
					kind: 'paused',
					why: `today's estimated spend, ${dollars(today)}, reached the daily limit of ${dollars(this.setup.limits.dailyUsd)}`
				};
				break;
			}
			const ticket = nextTicket(this.tickets, this.built);
			if (ticket === null) break;
			last = await this.buildTicket(ticket);
		}
		return this.finish(last);
	}

	private async trusted(id: ItemId): Promise<Comment[]> {
		return (await this.deps.tracker.comments(id)).filter((c) => c.trusted);
	}

	private log(entry: LogEntry) {
		this.spent += entry.costUsd;
		record(ledgerPath(this.setup.root), {
			at: this.deps.now().toISOString(),
			repo: this.setup.repo,
			feature: this.feature.id,
			branch: this.tree.at.branch,
			...entry
		});
	}

	private request(
		over: Partial<SessionRequest> & Pick<SessionRequest, 'prompt' | 'sessionId'>
	): SessionRequest {
		const { setup } = this;
		return {
			cwd: this.tree.at.folder,
			schema: BUILD_SCHEMA,
			tools: BUILD_TOOLS,
			settings: buildSettings(setup.allowedCommands),
			budgetUsd: setup.limits.ticketUsd,
			minutes: setup.limits.ticketMinutes,
			log: join(logsPath(setup.root), `${over.sessionId}.jsonl`),
			allowApiKey: setup.allowApiKey,
			env: envOf(setup),
			signal: setup.signal,
			...over
		};
	}

	// Hands a Ticket to a person: no code kept on the branch, the reason on the Ticket.
	private async handBack(
		ticket: Ticket,
		before: string,
		body: string,
		signal: Signal,
		why: string
	) {
		const { tracker } = this.deps;
		this.deps.status.happened({
			kind: 'needs-info',
			feature: this.feature.id,
			ticket: ticket.id,
			why
		});
		const side = await this.tree.discard(before, ticket.id);
		const kept = side ? `\n\nThe attempt is kept on branch \`${side}\`.` : '';
		await tracker.comment(ticket.id, `${body}${kept}${FOOTER}`);
		await tracker.removeSignal(ticket.id, 'ready');
		await tracker.addSignal(ticket.id, signal);
		const i = this.tickets.indexOf(ticket);
		this.tickets[i] = {
			...ticket,
			signals: [...ticket.signals.filter((s) => s !== 'ready'), signal]
		};
	}

	private async buildTicket(ticket: Ticket): Promise<Step> {
		const before = await this.tree.head();
		const sessionId = this.deps.newId();
		const ticketComments = await this.trusted(ticket.id);
		this.deps.say(`${hash(ticket.id)} ${ticket.title}: session ${sessionId}`);
		this.building(ticket.id, 'build', sessionId, {
			round: questionRounds(ticketComments) + 1,
			rounds: this.setup.limits.questionRounds + 1
		});
		const prompt = buildPrompt({
			feature: this.feature,
			ticket,
			featureComments: this.featureComments,
			ticketComments,
			built: this.tickets.filter((t) => this.built.has(t.id)),
			allowed: this.setup.allowedCommands,
			check: this.setup.check,
			rules: this.setup.rules
		});
		const result = await this.deps.session(
			this.request({
				prompt,
				sessionId,
				model: this.setup.model ?? ticketLine(ticket.body, 'Model') ?? this.setup.defaults?.model,
				effort:
					this.setup.effort ?? ticketLine(ticket.body, 'Effort') ?? this.setup.defaults?.effort
			})
		);
		const cost = 'costUsd' in result ? result.costUsd : 0;
		const entry = { ticket: ticket.id, step: 'build' as const, session: sessionId, costUsd: cost };

		if (this.aborted) {
			this.log({ ...entry, outcome: 'stopped by a person' });
			await this.tree.discard(before, ticket.id);
			return { kind: 'aborted' };
		}
		if (result.kind === 'api-key' || result.kind === 'rate-limited') {
			await this.tree.discard(before, ticket.id);
			const why = result.kind === 'api-key' ? API_KEY_PAUSE : limitPause(result.resetsAt);
			this.log({ ...entry, outcome: `paused: ${why}` });
			return { kind: 'paused', why };
		}
		const answer = result.kind === 'done' ? readBuildAnswer(result.output) : null;
		if (answer === null) {
			const why = result.kind === 'stopped' ? result.why : 'it answered in a shape not known';
			this.log({ ...entry, outcome: `failed: ${why}` });
			await this.handBack(
				ticket,
				before,
				`Nightjar could not build this Ticket: ${why}.\n\nSession: \`claude --resume ${sessionId}\``,
				'needsInfo',
				why
			);
			return NEXT;
		}
		if (answer.outcome === 'questions') {
			const round = questionRounds(ticketComments) + 1;
			this.log({ ...entry, outcome: `questions, round ${String(round)}` });
			await this.askAbout(ticket, before, answer.questions, round);
			return NEXT;
		}
		this.log({ ...entry, outcome: 'built' });
		return this.checkAndCommit(ticket, before, sessionId, answer.summary, cost);
	}

	private async askAbout(ticket: Ticket, before: string, questions: Question[], round: number) {
		const limit = this.setup.limits.questionRounds;
		if (round <= limit) {
			const asked = `it asked ${String(questions.length)} question${questions.length === 1 ? '' : 's'}, round ${String(round)}`;
			await this.handBack(ticket, before, questionsComment(questions, round), 'needsInfo', asked);
			return;
		}
		const asked = questions.map((q, i) => `${String(i + 1)}. ${q.question}`).join('\n');
		await this.handBack(
			ticket,
			before,
			`Nightjar asked about this Ticket ${String(limit)} times and still has questions, so it needs a person:\n\n${asked}`,
			'human',
			`still unclear after ${String(limit)} question rounds, so a person builds it`
		);
	}

	// The repo's check, the fix rounds while it fails, and the Ticket's one commit.
	private async checkAndCommit(
		ticket: Ticket,
		before: string,
		sessionId: string,
		built: string,
		cost: number
	): Promise<Step> {
		const { limits, check: command } = this.setup;
		let summary = built;
		let ticketSpent = cost;
		let check = await this.deps.runCheck(command, this.tree.at.folder, envOf(this.setup));
		for (let round = 1; !check.ok && round <= limits.fixRounds; round += 1) {
			const budget = limits.ticketUsd - ticketSpent;
			if (budget < 1) break;
			this.deps.say(`${hash(ticket.id)}: the check fails, fix round ${String(round)}`);
			this.building(ticket.id, 'fix', sessionId, { round, rounds: limits.fixRounds });
			const fix = await this.deps.session(
				this.request({
					prompt: fixPrompt(round, limits.fixRounds, command, check.tail),
					sessionId,
					resume: sessionId,
					budgetUsd: budget
				})
			);
			const fixed = fix.kind === 'done' ? readBuildAnswer(fix.output) : null;
			const fixCost = 'costUsd' in fix ? fix.costUsd : 0;
			ticketSpent += fixCost;
			const done = fixed?.outcome === 'built';
			this.log({
				ticket: ticket.id,
				step: 'fix',
				session: sessionId,
				costUsd: fixCost,
				outcome: `round ${String(round)}${done ? '' : ' gave up'}`
			});
			if (!done || this.aborted) break;
			summary = `${summary}\n\n${fixed.summary}`;
			check = await this.deps.runCheck(command, this.tree.at.folder, envOf(this.setup));
		}
		if (this.aborted) {
			await this.tree.discard(before, ticket.id);
			return { kind: 'aborted' };
		}
		if (!(await this.tree.commitTicket(ticket.id, ticket.title, summary, sessionId))) {
			await this.handBack(
				ticket,
				before,
				`Nightjar's session said it built this Ticket but changed no file.\n\nSession: \`claude --resume ${sessionId}\``,
				'needsInfo',
				'it said it built the Ticket but changed no file'
			);
			return NEXT;
		}
		this.built.add(ticket.id);
		this.deps.status.happened({ kind: 'built', feature: this.feature.id, ticket: ticket.id });
		// later Tickets would build on red, so the run stops here and a person looks
		return check.ok ? NEXT : { kind: 'red', tail: check.tail };
	}

	private building(
		ticket: ItemId,
		step: 'build' | 'fix',
		session: string,
		rounds: { readonly round: number; readonly rounds: number }
	) {
		this.deps.status.doing({
			kind: 'building',
			feature: this.feature.id,
			ticket,
			step,
			...rounds,
			session,
			startedAt: this.deps.now().toISOString()
		});
	}

	private async finish(last: Step): Promise<FeatureOutcome> {
		const { tracker, codeHost } = this.deps;
		const id = this.feature.id;
		const left = waiting(this.tickets, this.built);
		const paused = last.kind === 'paused' ? last.why : null;
		await tracker.removeSignal(id, 'working');
		if (this.aborted || last.kind === 'aborted') {
			await tracker.comment(id, `The Nightjar run was stopped by a person.${FOOTER}`);
			return { kind: 'stopped' };
		}
		if (paused) {
			// the Go back, so a later run goes on from the branch
			await tracker.addSignal(id, 'go');
			this.deps.say(`paused: ${paused}`);
			this.deps.status.doing({ kind: 'paused', why: paused, until: null });
		}
		if ((await this.tree.ahead()) === 0) {
			if (paused) return { kind: 'paused', why: paused };
			this.deps.status.happened({
				kind: 'needs-info',
				feature: id,
				ticket: null,
				why: 'it built nothing'
			});
			await tracker.addSignal(id, 'needsInfo');
			await tracker.comment(
				id,
				`Nightjar built nothing for this Feature.\n\n${waitingList(left)}${FOOTER}`
			);
			return { kind: 'nothing', waiting: left };
		}

		const red =
			last.kind === 'red' ? { ticket: [...this.built].at(-1) ?? '', tail: last.tail } : null;
		const done = [...this.built].flatMap((n) => this.tickets.filter((t) => t.id === n));
		const review =
			this.setup.review?.enabled === false
				? 'off'
				: await reviewFeature(this.deps, this.setup, this.tree, this.feature, done, (e) =>
						this.log(e)
					);
		await codeHost.push(this.tree.at.folder, this.tree.at.branch);
		const complete = left.length === 0 && red === null && paused === null;
		const body = pullBody({
			tracker,
			feature: this.feature,
			check: this.setup.check,
			complete,
			done,
			left,
			red,
			review,
			spent: this.spent,
			paused
		});
		const pull = await this.openDraft(body);
		const linked = [...(complete ? [id] : []), ...done.map((t) => t.id)];
		await codeHost.placeReferences(
			pull,
			linked.map((n) => tracker.reference(n))
		);
		if (review !== 'off' && review) await codeHost.comment(pull, reviewComment(review));
		this.deps.say(`${hash(id)}: draft pull request ${pull.url}`);
		this.deps.status.happened({ kind: 'pull', feature: id, url: pull.url });
		if (!paused && (left.length > 0 || red)) {
			const waits = `${String(left.length)} Ticket${left.length === 1 ? '' : 's'} wait`;
			this.deps.status.happened({
				kind: 'needs-info',
				feature: id,
				ticket: null,
				why: red ? `the check fails after ${hash(red.ticket)}` : waits
			});
			await tracker.addSignal(id, 'needsInfo');
			const failing = red ? `The check fails after ${hash(red.ticket)}.\n\n` : '';
			await tracker.comment(
				id,
				`Nightjar opened ${pull.url}, and this Feature still needs a person.\n\n${failing}${waitingList(left)}${FOOTER}`
			);
		}
		return { kind: 'pull', pull, built: [...this.built], waiting: left };
	}

	// The branch's open pull request with a new body, else a new draft.
	private async openDraft(body: string): Promise<Pull> {
		const { codeHost } = this.deps;
		const open = await codeHost.openPull(this.tree.at.branch);
		if (open) {
			await codeHost.editBody(open, body);
			return open;
		}
		return codeHost.createDraft({
			title: this.feature.title,
			head: this.tree.at.branch,
			base: this.setup.baseBranch,
			body
		});
	}
}

const API_KEY_PAUSE =
	'the session billed an API key; unset ANTHROPIC_API_KEY or pass --use-api-key';

const limitPause = (resetsAt: number | null) =>
	`the plan's usage limit was reached${resetsAt ? `; it resets at ${new Date(resetsAt * 1000).toISOString()}` : ''}`;

async function reviewFeature(
	deps: Deps,
	setup: Setup,
	tree: Worktree,
	feature: Feature,
	built: readonly Ticket[],
	log: (entry: LogEntry) => void
): Promise<Review | null> {
	const sessionId = deps.newId();
	deps.say(`${hash(feature.id)}: review, session ${sessionId}`);
	deps.status.doing({
		kind: 'building',
		feature: feature.id,
		ticket: null,
		step: 'review',
		round: null,
		rounds: null,
		session: sessionId,
		startedAt: deps.now().toISOString()
	});
	const result = await deps.session({
		cwd: tree.at.folder,
		prompt: reviewPrompt(feature, tree.at.base, built, setup.rules),
		schema: REVIEW_SCHEMA,
		tools: REVIEW_TOOLS,
		settings: reviewSettings(),
		budgetUsd: setup.limits.reviewUsd,
		minutes: setup.limits.reviewMinutes,
		model: setup.model ?? setup.review?.model ?? setup.defaults?.model,
		effort: setup.effort ?? setup.review?.effort ?? setup.defaults?.effort,
		sessionId,
		log: join(logsPath(setup.root), `${sessionId}.jsonl`),
		allowApiKey: setup.allowApiKey,
		env: envOf(setup),
		signal: setup.signal
	});
	const review = result.kind === 'done' ? readReview(result.output) : null;
	log({
		ticket: null,
		step: 'review',
		session: sessionId,
		costUsd: 'costUsd' in result ? result.costUsd : 0,
		outcome: review
			? review.verdict
			: result.kind === 'stopped'
				? `failed: ${result.why}`
				: result.kind
	});
	return review;
}

// `name` is how the place the list goes names a Ticket: #N on the Tracker, its reference on the Code host.
function waitingList(left: readonly Waiting[], name: (id: ItemId) => string = hash): string {
	if (left.length === 0) return 'No Ticket is waiting.';
	const line = (w: Waiting) =>
		`- ${name(w.id)} ${w.title}: ${w.why}${w.blocker === undefined ? '' : ` ${name(w.blocker)}`}`;
	return `Waiting:\n\n${left.map(line).join('\n')}`;
}

function pullBody(p: {
	tracker: Tracker;
	feature: Feature;
	check: string;
	complete: boolean;
	// in the order they were built, which is the order of the branch's commits
	done: readonly Ticket[];
	left: readonly Waiting[];
	red: { ticket: ItemId; tail: string } | null;
	review: Review | 'off' | null;
	spent: number;
	paused: string | null;
}): string {
	const ref = (id: ItemId) => p.tracker.reference(id).text;
	const parts = [
		`Nightjar built ${p.complete ? 'all of' : 'part of'} ${ref(p.feature.id)} ${p.feature.title}.`,
		`## Built\n\n${p.done.map((t) => `- ${ref(t.id)} ${t.title}`).join('\n')}`
	];
	if (p.red) {
		parts.push(
			`## The check fails\n\nAfter ${ref(p.red.ticket)}, \`${p.check}\` still fails after the fix rounds:\n\n\`\`\`\n${p.red.tail}\n\`\`\``
		);
	}
	if (p.left.length > 0) parts.push(`## ${waitingList(p.left, ref)}`);
	if (p.paused)
		parts.push(
			`## Paused\n\nThe run paused because ${p.paused}. It goes on from here when the Feature gets the Go again.`
		);
	if (p.review !== 'off')
		parts.push(
			`## Review\n\n${p.review ? `${p.review.verdict === 'approve' ? 'Approve' : 'Changes asked'}: ${p.review.summary}` : 'The review did not finish.'}`
		);
	parts.push(`Estimated cost of this run: ${dollars(p.spent)}.`);
	return `${parts.join('\n\n')}${FOOTER}`;
}

function reviewComment(review: Review): string {
	const issues = review.issues
		.map((i) => `- \`${i.file}${i.line ? `:${String(i.line)}` : ''}\`: ${i.problem}`)
		.join('\n');
	return `**Nightjar review: ${review.verdict === 'approve' ? 'approve' : 'changes'}**\n\n${review.summary}${issues ? `\n\n${issues}` : ''}${FOOTER}`;
}
