// The build loop: one Feature from the Go to a draft pull request, through the Tracker and Code host seams alone.
import { join } from 'node:path';
import type { CheckResult, RunCheck } from './check.js';
import type { CodeHost, Feedback, Pull } from './code-host.js';
import { envOf, type CodingAgent, type Fixing } from './coding-agent.js';
import { FOOTER } from './footer.js';
import type { Env } from './git.js';
import { feedbackRounds, record, spentOn, type Entry } from './ledger.js';
import { DEFAULT_DAILY_USD } from './person-config.js';
import { nextTicket, progress, waiting, type Waiting } from './plan.js';
import {
	feedbackPlace,
	questionRounds,
	questionsComment,
	type Question,
	type Review
} from './prompt.js';
import type { Serve, Served } from './serve.js';
import type { Signal } from './signals.js';
import type { Doing, StatusReport, TicketProgress } from './status.js';
import type { Comment, Feature, ItemId, Ticket, Tracker } from './tracker.js';
import { branchFor, openWorktree, type Worktree } from './worktree.js';
import { DEFAULT_ROUNDS } from './config.js';
import {
	chooseWorkflow,
	stepKey,
	workflowSection,
	type StepConfig,
	type StepPoint,
	type StepReport,
	type WorkflowConfig,
	type WorkflowSettings
} from './workflow.js';

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
	readonly codingAgent: CodingAgent;
	readonly runCheck: RunCheck;
	// the worktree setup command, run through the same shell as the check
	readonly runSetup: RunCheck;
	// starts a Workflow's serve command
	readonly serve: Serve;
	readonly now: () => Date;
	readonly newId: () => string;
	readonly say: (line: string) => void;
	readonly status: StatusReport;
}

export interface Setup extends WorkflowSettings {
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

export const ledgerPath = (root: string) => join(root, '.factory', 'runs.jsonl');

const dollars = (n: number) => `$${n.toFixed(2)}`;
const hash = (id: ItemId) => `#${id}`;
const pieces = (n: number) => `${String(n)} piece${n === 1 ? '' : 's'} of feedback`;

type LogEntry = Omit<Entry, 'at' | 'repo' | 'feature' | 'branch'>;

// The kind of work a Session's cost is split under in the pull request; a Step's fix rounds belong to 'steps', a Feedback round's to 'feedback'.
type Work = 'build' | 'fix' | 'steps' | 'review' | 'feedback';

// What this run spent on one kind of work, after one Ticket or, with no Ticket, after all of them.
interface Cost {
	readonly ticket: ItemId | null;
	readonly work: Work;
	readonly usd: number;
}

const workOf = (step: Entry['step']): Work => (step === 'step' ? 'steps' : step);

// The kind of work the fix rounds of each piece of work count under.
const FIXES: Record<Fixing['kind'], Work> = { build: 'fix', step: 'steps', feedback: 'feedback' };

// What building one Ticket left the run to do next.
type Step =
	| { readonly kind: 'next' }
	| { readonly kind: 'paused'; readonly why: string }
	| { readonly kind: 'aborted' }
	| { readonly kind: 'red'; readonly tail: string };

const NEXT: Step = { kind: 'next' };

// What ends a piece of work before its own end: the run goes on later, or a person stopped it.
type Halt = Extract<Step, { kind: 'paused' | 'aborted' }>;

// A piece of feedback a Feedback round did not answer, and why.
interface Unanswered {
	readonly feedback: Feedback;
	readonly why: string;
}

// How this run's Feedback round ended: one commit to reply with, or thrown away.
type FeedbackEnd =
	| {
			readonly kind: 'committed';
			readonly sha: string;
			readonly answered: readonly { readonly feedback: Feedback; readonly note: string }[];
			readonly left: readonly Unanswered[];
	  }
	| {
			readonly kind: 'thrown';
			readonly why: string;
			// the failing check's output, when that is why
			readonly tail?: string;
			readonly left: readonly Unanswered[];
	  };

export async function buildFeature(deps: Deps, setup: Setup, id: ItemId): Promise<FeatureOutcome> {
	const { tracker } = deps;
	const feature = await tracker.feature(id);
	const branch = branchFor(feature.id, feature.title);
	deps.say(`${hash(id)} ${feature.title}: building on ${branch}`);
	await tracker.addSignal(id, 'working');
	await tracker.removeSignal(id, 'go');
	const show = buildingOf(feature, deps.now);
	const settingUp = (tickets?: TicketProgress[]): Doing =>
		show({
			ticket: null,
			step: 'setup',
			round: null,
			rounds: null,
			session: null,
			...(tickets === undefined ? {} : { tickets })
		});
	deps.status.doing(settingUp());
	const tickets = await tracker.tickets(id);
	const chosen = chooseWorkflow(setup, feature.body);
	if (chosen.kind === 'refused') {
		const why = `its Workflow cannot be used: ${chosen.why}`;
		return needsInfoStop(
			deps,
			id,
			why,
			`Nightjar built nothing: ${chosen.why}`,
			waiting(tickets, new Set())
		);
	}
	const tree = await openWorktree(setup.root, setup.worktrees, branch, setup.baseBranch, setup.env);
	const built = await tree.built();
	// the Tickets are planned once the branch says which are built
	deps.status.doing(settingUp(progress(tickets, built, null)));
	if (setup.setupCommand !== undefined && !(await tree.isSetUp())) {
		const command = setup.setupCommand;
		deps.say(`${hash(id)}: setup: ${command}`);
		const got = await deps.runSetup(command, tree.at.folder, envOf(setup));
		if (!got.ok) {
			const why = `the setup command \`${command}\` failed`;
			return needsInfoStop(
				deps,
				id,
				why,
				`Nightjar built nothing: ${why} in the worktree.\n\n\`\`\`\n${got.tail}\n\`\`\``,
				waiting(tickets, built)
			);
		}
		await tree.markSetUp();
	}
	const workflow = chosen.kind === 'workflow' ? chosen : null;
	const run = new FeatureRun(deps, setup, feature, tree, tickets, built, workflow, show);
	return run.build();
}

// A Feature stopped before it built anything, with the reason on it; a later Go builds it again.
async function needsInfoStop(
	deps: Deps,
	id: ItemId,
	why: string,
	comment: string,
	left: Waiting[]
): Promise<FeatureOutcome> {
	deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why });
	await deps.tracker.removeSignal(id, 'working');
	await deps.tracker.addSignal(id, 'needsInfo');
	await deps.tracker.comment(id, `${comment}${FOOTER}`);
	return { kind: 'nothing', waiting: left };
}

// How one Step of a Workflow ended.
type StepEnd =
	| { readonly kind: 'done' }
	| { readonly kind: 'undone'; readonly why: string }
	| { readonly kind: 'paused'; readonly why: string }
	| { readonly kind: 'aborted' };

// The most of a Feature's diff a Step's prompt carries; the rest is in git.
const DIFF_CHARS = 60_000;

type Building = Extract<Doing, { kind: 'building' }>;
type ShowBuilding = (
	at: Pick<Building, 'ticket' | 'step' | 'round' | 'rounds' | 'session' | 'tickets'>
) => Building;

// One Feature's building states: the Feature's start in every one, and a fresh start for each step.
function buildingOf(feature: Feature, now: () => Date): ShowBuilding {
	const featureStartedAt = now().toISOString();
	return (at) => ({
		kind: 'building',
		feature: feature.id,
		title: feature.title,
		featureStartedAt,
		startedAt: now().toISOString(),
		...at
	});
}

class FeatureRun {
	private spent = 0;
	private readonly costs: Cost[] = [];
	private featureComments: Comment[] = [];
	// the Steps the branch holds already, by their trailers
	private stepsDone = new Set<string>();
	private readonly reports: StepReport[] = [];
	// what the status file shows now, so a Ticket built can change its Tickets alone
	private shown: Doing | null = null;
	// this run's Feedback round, once it ran to an end of its own
	private answered: FeedbackEnd | null = null;

	constructor(
		private readonly deps: Deps,
		private readonly setup: Setup,
		private readonly feature: Feature,
		private readonly tree: Worktree,
		private readonly tickets: Ticket[],
		private readonly built: Set<ItemId>,
		private readonly workflow: { readonly name: string; readonly workflow: WorkflowConfig } | null,
		private readonly show: ShowBuilding
	) {}

	private get aborted() {
		return this.setup.signal?.aborted === true;
	}

	async build(): Promise<FeatureOutcome> {
		this.featureComments = await this.trusted(this.feature.id);
		if (this.workflow !== null) this.stepsDone = await this.tree.stepsDone();
		let last: Step = NEXT;
		while (last.kind === 'next' && !this.aborted) {
			const paused = this.dailyPause();
			if (paused !== null) {
				last = { kind: 'paused', why: paused };
				break;
			}
			const ticket = nextTicket(this.tickets, this.built);
			if (ticket === null) break;
			last = await this.buildTicket(ticket);
		}
		// the Steps of "all Tickets" run on a Feature whose Tickets are all built
		const whole = this.built.size > 0 && waiting(this.tickets, this.built).length === 0;
		if (last.kind === 'next' && !this.aborted && whole) {
			last = await this.runSteps('afterAllTickets', null);
		}
		if (last.kind === 'next' && !this.aborted) last = await this.answerFeedback();
		return this.finish(last);
	}

	private dailyPause(): string | null {
		const today = spentOn(ledgerPath(this.setup.root), this.deps.now());
		return today >= this.setup.limits.dailyUsd
			? `today's estimated spend, ${dollars(today)}, reached the daily limit of ${dollars(this.setup.limits.dailyUsd)}`
			: null;
	}

	private async trusted(id: ItemId): Promise<Comment[]> {
		return (await this.deps.tracker.comments(id)).filter((c) => c.trusted);
	}

	private log(entry: LogEntry, work: Work = workOf(entry.step)) {
		this.spent += entry.costUsd;
		this.costs.push({ ticket: entry.ticket, work, usd: entry.costUsd });
		record(ledgerPath(this.setup.root), {
			at: this.deps.now().toISOString(),
			repo: this.setup.repo,
			feature: this.feature.id,
			branch: this.tree.at.branch,
			...entry
		});
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
		const got = await this.deps.codingAgent.build({
			kind: 'build',
			at: this.tree.at,
			sessionId,
			feature: this.feature,
			ticket,
			featureComments: this.featureComments,
			ticketComments,
			built: this.tickets.filter((t) => this.built.has(t.id)),
			budgetUsd: this.setup.limits.ticketUsd
		});
		const entry = {
			ticket: ticket.id,
			step: 'build' as const,
			session: sessionId,
			costUsd: got.costUsd
		};

		switch (got.kind) {
			case 'aborted':
				this.log({ ...entry, outcome: 'stopped by a person' });
				await this.tree.discard(before, ticket.id);
				return { kind: 'aborted' };
			case 'paused':
				await this.tree.discard(before, ticket.id);
				this.log({ ...entry, outcome: `paused: ${got.why}` });
				return { kind: 'paused', why: got.why };
			case 'failed':
				this.log({ ...entry, outcome: `failed: ${got.why}` });
				await this.handBack(
					ticket,
					before,
					`Nightjar could not build this Ticket: ${got.why}.\n\nSession: \`claude --resume ${sessionId}\``,
					'needsInfo',
					got.why
				);
				return NEXT;
			case 'questions': {
				const round = questionRounds(ticketComments) + 1;
				this.log({ ...entry, outcome: `questions, round ${String(round)}` });
				await this.askAbout(ticket, before, got.questions, round);
				return NEXT;
			}
			case 'built':
				this.log({ ...entry, outcome: 'built' });
				return this.checkAndCommit(ticket, before, sessionId, got.summary, got.costUsd);
		}
	}

	private async askAbout(
		ticket: Ticket,
		before: string,
		questions: readonly Question[],
		round: number
	) {
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
		const first = await this.deps.runCheck(command, this.tree.at.folder, envOf(this.setup));
		const fixed = await this.fixUntilGreen({
			ticket: ticket.id,
			name: hash(ticket.id),
			sessionId,
			cap: limits.ticketUsd,
			spent: cost,
			check: first,
			of: { kind: 'build' }
		});
		const { check } = fixed;
		const summary = [built, ...fixed.summaries].join('\n\n');
		if (fixed.halt !== undefined) {
			await this.tree.discard(before, ticket.id);
			return fixed.halt;
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
		if (this.shown?.kind === 'building') {
			// no round of its own any more, so it is not counted as another fix round
			this.deps.status.doing({
				...this.shown,
				step: 'build',
				round: null,
				rounds: null,
				tickets: progress(this.tickets, this.built, null)
			});
		}
		this.deps.status.happened({ kind: 'built', feature: this.feature.id, ticket: ticket.id });
		// later Tickets would build on red, so the run stops here and a person looks
		if (!check.ok) return { kind: 'red', tail: check.tail };
		return this.runSteps('afterEachTicket', ticket);
	}

	// Fix rounds while the check fails, each in the session that built the work; `cap` is the most the whole piece of work may cost.
	private async fixUntilGreen(o: {
		ticket: ItemId | null;
		// what the run says it is fixing
		name: string;
		sessionId: string;
		cap: number;
		spent: number;
		check: CheckResult;
		of: Fixing;
	}): Promise<{ check: CheckResult; spent: number; summaries: string[]; halt?: Halt }> {
		const { limits, check: command } = this.setup;
		const summaries: string[] = [];
		const work = FIXES[o.of.kind];
		let { check, spent } = o;
		for (let round = 1; !check.ok && round <= limits.fixRounds; round += 1) {
			const budget = o.cap - spent;
			if (budget < 1) break;
			this.deps.say(`${o.name}: the check fails, fix round ${String(round)}`);
			this.building(o.ticket, 'fix', o.sessionId, { round, rounds: limits.fixRounds });
			const got = await this.deps.codingAgent.fix({
				kind: 'fix',
				at: this.tree.at,
				of: o.of,
				resume: o.sessionId,
				round,
				tail: check.tail,
				budgetUsd: budget
			});
			spent += got.costUsd;
			const entry = { ticket: o.ticket, step: 'fix' as const, session: o.sessionId };
			if (got.kind === 'paused') {
				this.log({ ...entry, costUsd: got.costUsd, outcome: `paused: ${got.why}` }, work);
				return { check, spent, summaries, halt: { kind: 'paused', why: got.why } };
			}
			// the ledger names a fix round that failed or was stopped as one that gave up
			const gaveUp = got.kind !== 'fixed';
			this.log(
				{
					...entry,
					costUsd: got.costUsd,
					outcome: `round ${String(round)}${gaveUp ? ' gave up' : ''}`
				},
				work
			);
			if (got.kind === 'aborted') return { check, spent, summaries, halt: { kind: 'aborted' } };
			if (got.kind !== 'fixed') break;
			summaries.push(got.summary);
			check = await this.deps.runCheck(command, this.tree.at.folder, envOf(this.setup));
		}
		// a stop during the check, which no Session reports
		if (this.aborted) return { check, spent, summaries, halt: { kind: 'aborted' } };
		return { check, spent, summaries };
	}

	private building(
		ticket: ItemId | null,
		step: 'build' | 'fix' | 'step' | 'feedback',
		session: string,
		rounds: { readonly round: number | null; readonly rounds: number | null }
	) {
		this.shown = this.show({
			ticket,
			step,
			...rounds,
			session,
			tickets: progress(this.tickets, this.built, ticket)
		});
		this.deps.status.doing(this.shown);
	}

	// The Workflow's Steps at one point, in order; a Step that fails is thrown away and the next still runs.
	private async runSteps(point: StepPoint, ticket: Ticket | null): Promise<Step> {
		const { workflow } = this;
		if (workflow === null) return NEXT;
		const todo = workflow.workflow.steps.filter(
			(s) =>
				s.point === point && !this.stepsDone.has(stepKey(workflow.name, s.name, ticket?.id ?? null))
		);
		if (todo.length === 0) return NEXT;
		const served = await this.serveFor(workflow.workflow);
		try {
			for (const step of todo) {
				if (this.aborted) return { kind: 'aborted' };
				const paused = this.dailyPause();
				if (paused !== null) return { kind: 'paused', why: paused };
				const end: StepEnd = served.ok
					? await this.runStep(workflow.name, workflow.workflow, step, ticket)
					: { kind: 'undone', why: `its serve command failed: ${served.tail}` };
				if (end.kind === 'paused' || end.kind === 'aborted') return end;
				if (end.kind === 'undone') {
					this.reports.push({
						step,
						ticket: ticket?.id ?? null,
						state: 'undone',
						why: end.why,
						left: []
					});
					this.deps.say(`${workflow.name}/${step.name}: not done, ${end.why}`);
				}
			}
			return NEXT;
		} finally {
			if (served.ok) await served.stop();
		}
	}

	private async serveFor(workflow: WorkflowConfig): Promise<Served> {
		if (workflow.serve === undefined) return { ok: true, stop: () => Promise.resolve() };
		const first = Number(Object.values(this.setup.portEnv ?? {})[0]);
		this.deps.say(`${hash(this.feature.id)}: serving ${workflow.serve}`);
		return this.deps.serve(
			workflow.serve,
			this.tree.at.folder,
			envOf(this.setup),
			Number.isInteger(first) ? first : null
		);
	}

	// One Step: its rounds, the check and fix rounds after each, and its own commit.
	private async runStep(
		name: string,
		workflow: WorkflowConfig,
		step: StepConfig,
		ticket: Ticket | null
	): Promise<StepEnd> {
		const { setup } = this;
		const after = ticket?.id ?? null;
		const key = stepKey(name, step.name, after);
		const label = `${name}/${step.name}`;
		const before = await this.tree.head();
		const sessionId = this.deps.newId();
		const rounds = step.until === undefined ? 1 : (step.maxRounds ?? DEFAULT_ROUNDS);
		const cap = step.budgetUsd ?? setup.limits.ticketUsd;
		const notes = await this.tree.notes();
		const diff = step.point === 'afterAllTickets' ? await this.tree.diff(DIFF_CHARS) : undefined;
		const extras = {
			allowedCommands: workflow.allowedCommands,
			allowedTools: workflow.allowedTools,
			localNetwork: workflow.localNetwork
		};
		const giveUp = async (why: string): Promise<StepEnd> => {
			await this.tree.revert(before);
			return { kind: 'undone', why };
		};
		this.deps.say(`${label}: session ${sessionId}`);

		const summaries: string[] = [];
		let spent = 0;
		let left: readonly string[] = [];
		let holds = step.until === undefined;
		let ran = 0;
		for (let round = 1; round <= rounds && !(round > 1 && holds); round += 1) {
			const budget = cap - spent;
			if (round > 1 && budget < 1) break;
			this.building(after, 'step', sessionId, { round, rounds });
			const got = await this.deps.codingAgent.step({
				kind: 'step',
				at: this.tree.at,
				sessionId,
				workflow: name,
				step,
				extras,
				round,
				rounds,
				feature: this.feature,
				ticket,
				notes,
				...(diff === undefined ? {} : { diff }),
				left,
				budgetUsd: budget
			});
			ran = round;
			spent += got.costUsd;
			const entry = {
				ticket: after,
				step: 'step' as const,
				session: sessionId,
				costUsd: got.costUsd
			};
			switch (got.kind) {
				case 'aborted':
					this.log({ ...entry, outcome: `${label}: stopped by a person` });
					await this.tree.revert(before);
					return { kind: 'aborted' };
				case 'paused':
					await this.tree.revert(before);
					this.log({ ...entry, outcome: `${label}: paused: ${got.why}` });
					return { kind: 'paused', why: got.why };
				case 'failed':
					this.log({ ...entry, outcome: `${label}: failed: ${got.why}` });
					return giveUp(got.why);
				case 'blocked':
					this.log({ ...entry, outcome: `${label}: blocked` });
					return giveUp(`it reported itself blocked${got.blocker ? `: ${got.blocker}` : ''}`);
				case 'done':
					break;
			}
			this.log({ ...entry, outcome: `${label}: round ${String(round)}` });
			summaries.push(got.summary);
			const checked = await this.fixUntilGreen({
				ticket: after,
				name: label,
				sessionId,
				cap,
				spent,
				check: await this.deps.runCheck(setup.check, this.tree.at.folder, envOf(setup)),
				of: { kind: 'step', step, extras }
			});
			spent = checked.spent;
			summaries.push(...checked.summaries);
			if (checked.halt !== undefined) {
				await this.tree.revert(before);
				return checked.halt;
			}
			if (!checked.check.ok) return giveUp('its changes leave the check failing');
			left = got.left;
			holds = got.untilHolds;
		}
		await this.tree.commitStep({
			workflow: name,
			step: step.name,
			key,
			after,
			summary: summaries.join('\n\n'),
			session: sessionId
		});
		this.stepsDone.add(key);
		this.reports.push({
			step,
			ticket: after,
			state: holds ? 'done' : 'unmet',
			rounds: ran,
			left: holds ? [] : left
		});
		return { kind: 'done' };
	}

	// One Feedback round on the branch's open pull request, when it has trusted feedback no trailer on the branch names.
	private async answerFeedback(): Promise<Step> {
		const { codeHost, codingAgent } = this.deps;
		if (codeHost.feedback === undefined || codeHost.reply === undefined) return NEXT;
		const pull = await codeHost.openPull(this.tree.at.branch);
		if (pull === null) return NEXT;
		const done = await this.tree.feedbackAnswered();
		const todo = (await codeHost.feedback(pull)).filter((f) => f.trusted && !done.has(f.id));
		if (todo.length === 0) return NEXT;
		const paused = this.dailyPause();
		if (paused !== null) return { kind: 'paused', why: paused };

		const { setup } = this;
		const before = await this.tree.head();
		const sessionId = this.deps.newId();
		const cap = setup.limits.ticketUsd;
		const name = `${hash(this.feature.id)} feedback`;
		this.deps.say(`${name}: ${pieces(todo.length)} on ${pull.url}, session ${sessionId}`);
		this.building(null, 'feedback', sessionId, { round: null, rounds: null });
		const got = await codingAgent.feedback({
			kind: 'feedback',
			at: this.tree.at,
			sessionId,
			feature: this.feature,
			feedback: todo,
			diff: await this.tree.diff(DIFF_CHARS),
			budgetUsd: cap
		});
		const entry = {
			ticket: null,
			step: 'feedback' as const,
			session: sessionId,
			costUsd: got.costUsd
		};
		const throwAway = async (why: string, left: readonly Unanswered[], tail?: string) => {
			await this.tree.revert(before);
			this.answered = { kind: 'thrown', why, left, ...(tail === undefined ? {} : { tail }) };
			this.deps.say(`${name}: thrown away, ${why}`);
			return NEXT;
		};
		const all = (why: string) => todo.map((feedback) => ({ feedback, why }));
		switch (got.kind) {
			case 'aborted':
				this.log({ ...entry, outcome: 'stopped by a person' });
				await this.tree.revert(before);
				return { kind: 'aborted' };
			case 'paused':
				await this.tree.revert(before);
				this.log({ ...entry, outcome: `paused: ${got.why}` });
				return { kind: 'paused', why: got.why };
			case 'failed':
				this.log({ ...entry, outcome: `failed: ${got.why}` });
				return throwAway(got.why, all(got.why));
			case 'blocked': {
				this.log({ ...entry, outcome: 'blocked' });
				const why = `it reported itself blocked${got.blocker ? `: ${got.blocker}` : ''}`;
				return throwAway(why, all(why));
			}
			case 'answered':
				break;
		}
		const said = (f: Feedback) => got.answers.find((a) => a.id === f.id);
		const answered = todo.flatMap((feedback) => {
			const a = said(feedback);
			return a?.answered === true ? [{ feedback, note: a.note }] : [];
		});
		const left = todo.flatMap((feedback): Unanswered[] => {
			const a = said(feedback);
			if (a?.answered === true) return [];
			return [{ feedback, why: a === undefined ? 'the round said nothing of it' : a.note }];
		});
		this.log({
			...entry,
			outcome: `answered ${String(answered.length)} of ${String(todo.length)}`
		});
		if (answered.length === 0) return throwAway('it answered none of the feedback', left);
		const checked = await this.fixUntilGreen({
			ticket: null,
			name,
			sessionId,
			cap,
			spent: got.costUsd,
			check: await this.deps.runCheck(setup.check, this.tree.at.folder, envOf(setup)),
			of: { kind: 'feedback' }
		});
		if (checked.halt !== undefined) {
			await this.tree.revert(before);
			return checked.halt;
		}
		if (!checked.check.ok) {
			const why = 'its changes leave the check failing after the fix rounds';
			return throwAway(why, all(why), checked.check.tail);
		}
		const sha = await this.tree.commitFeedback({
			ids: answered.map((a) => a.feedback.id),
			summary: [got.summary, ...checked.summaries].join('\n\n'),
			session: sessionId
		});
		this.answered = { kind: 'committed', sha, answered, left };
		return NEXT;
	}

	// Each piece of feedback the round answered gets a reply naming its commit; one that cannot be answered any more is said and skipped.
	private async reply(pull: Pull, end: Extract<FeedbackEnd, { kind: 'committed' }>) {
		const { codeHost } = this.deps;
		if (codeHost.reply === undefined) return;
		for (const { feedback, note } of end.answered) {
			const body = `${note.trim() === '' ? '' : `${note.trim()}\n\n`}Answered in ${end.sha}.`;
			try {
				await codeHost.reply(pull, feedback.id, body);
			} catch (e) {
				const why = e instanceof Error ? e.message : String(e);
				this.deps.say(`could not reply to ${feedback.id}: ${why}`);
			}
		}
	}

	private async finish(last: Step): Promise<FeatureOutcome> {
		const { tracker, codeHost } = this.deps;
		const id = this.feature.id;
		const left = waiting(this.tickets, this.built);
		let paused = last.kind === 'paused' ? last.why : null;
		await tracker.removeSignal(id, 'working');
		if (this.aborted || last.kind === 'aborted') {
			await tracker.comment(id, `The Nightjar run was stopped by a person.${FOOTER}`);
			return { kind: 'stopped' };
		}
		if (paused) await this.pause(paused);
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
		let review: Review | 'off' | null = 'off';
		if (this.setup.review?.enabled !== false) {
			const got = await reviewFeature(
				this.deps,
				this.setup,
				this.tree,
				this.feature,
				done,
				progress(this.tickets, this.built, null),
				this.show,
				(e) => this.log(e)
			);
			if (got !== null && 'paused' in got) {
				// the pull request's Paused section says why, so it gets no Review section
				if (paused === null) {
					paused = got.paused;
					await this.pause(paused);
				}
			} else {
				review = got;
			}
		}
		await codeHost.push(this.tree.at.folder, this.tree.at.branch);
		const complete = left.length === 0 && red === null && paused === null;
		const workflow = this.workflowSection(done);
		const answered = this.answered;
		const feedback = feedbackSection(
			feedbackRounds(ledgerPath(this.setup.root), this.setup.repo, this.tree.at.branch),
			answered
		);
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
			costs: this.costs,
			titleOf: (id) => this.tickets.find((t) => t.id === id)?.title,
			paused,
			workflow,
			feedback
		});
		const pull = await this.openDraft(body);
		const linked = [...(complete ? [id] : []), ...done.map((t) => t.id)];
		await codeHost.placeReferences(
			pull,
			linked.map((n) => tracker.reference(n))
		);
		if (review !== 'off' && review) await codeHost.comment(pull, reviewComment(review));
		if (answered?.kind === 'committed') await this.reply(pull, answered);
		this.deps.say(`${hash(id)}: draft pull request ${pull.url}`);
		this.deps.status.happened({
			kind: 'pull',
			feature: id,
			title: this.feature.title,
			url: pull.url
		});
		const unanswered = answered === null || answered.left.length === 0 ? null : answered;
		if (!paused && (left.length > 0 || red || unanswered)) {
			const waits = `${String(left.length)} Ticket${left.length === 1 ? '' : 's'} wait`;
			const why = red
				? `the check fails after ${hash(red.ticket)}`
				: left.length > 0
					? waits
					: unanswered?.kind === 'thrown'
						? `its Feedback round was thrown away: ${unanswered.why}`
						: `${pieces(unanswered?.left.length ?? 0)} left unanswered`;
			this.deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why });
			await tracker.addSignal(id, 'needsInfo');
			const failing = red ? `The check fails after ${hash(red.ticket)}.\n\n` : '';
			const feedbackLeft = unanswered === null ? '' : `${unansweredText(unanswered)}\n\n`;
			const tickets = unanswered !== null && left.length === 0 ? '' : waitingList(left);
			const said = `Nightjar opened ${pull.url}, and this Feature still needs a person.\n\n${failing}${feedbackLeft}${tickets}`;
			await tracker.comment(id, `${said.trimEnd()}${FOOTER}`);
		}
		return { kind: 'pull', pull, built: [...this.built], waiting: left };
	}

	// The Go back, so a later run goes on from the branch.
	private async pause(why: string): Promise<void> {
		await this.deps.tracker.addSignal(this.feature.id, 'go');
		this.deps.say(`paused: ${why}`);
		this.deps.status.doing({ kind: 'paused', why, until: null });
	}

	// What the Workflow's Steps did, from this run and from the branch's commits; a Step that did not run is listed too.
	private workflowSection(done: readonly Ticket[]): string | null {
		const { workflow } = this;
		if (workflow === null) return null;
		const reports = [...this.reports];
		const seen = (step: StepConfig, ticket: ItemId | null) =>
			reports.some((r) => r.step === step && r.ticket === ticket);
		const pairs = workflow.workflow.steps.flatMap((step): [StepConfig, ItemId | null][] =>
			step.point === 'afterEachTicket' ? done.map((t) => [step, t.id]) : [[step, null]]
		);
		for (const [step, ticket] of pairs) {
			if (seen(step, ticket)) continue;
			if (this.stepsDone.has(stepKey(workflow.name, step.name, ticket))) {
				reports.push({ step, ticket, state: 'done', left: [] });
			} else if (step.point === 'afterAllTickets') {
				const why = 'it did not run, as the Feature is not complete';
				reports.push({ step, ticket, state: 'undone', why, left: [] });
			}
		}
		const order = (r: StepReport) => workflow.workflow.steps.indexOf(r.step);
		reports.sort((a, b) => order(a) - order(b));
		return workflowSection(workflow.name, reports, (id) => this.deps.tracker.reference(id).text);
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

async function reviewFeature(
	deps: Deps,
	setup: Setup,
	tree: Worktree,
	feature: Feature,
	built: readonly Ticket[],
	tickets: TicketProgress[],
	show: ShowBuilding,
	log: (entry: LogEntry) => void
): Promise<Review | null | { readonly paused: string }> {
	const sessionId = deps.newId();
	deps.say(`${hash(feature.id)}: review, session ${sessionId}`);
	deps.status.doing(
		show({ ticket: null, step: 'review', round: null, rounds: null, session: sessionId, tickets })
	);
	const got = await deps.codingAgent.review({
		kind: 'review',
		at: tree.at,
		sessionId,
		feature,
		tickets: built,
		budgetUsd: setup.limits.reviewUsd
	});
	const entry = { ticket: null, step: 'review' as const, session: sessionId, costUsd: got.costUsd };
	switch (got.kind) {
		case 'paused':
			log({ ...entry, outcome: `paused: ${got.why}` });
			return { paused: got.why };
		case 'reviewed':
			log({ ...entry, outcome: got.review.verdict });
			return got.review;
		// a stopped review is one that did not finish: the run is past its last Ticket
		case 'aborted':
			log({ ...entry, outcome: 'failed: stopped by a person' });
			return null;
		case 'failed':
			log({ ...entry, outcome: `failed: ${got.why}` });
			return null;
	}
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
	costs: readonly Cost[];
	titleOf: (id: ItemId) => string | undefined;
	paused: string | null;
	// the Workflow's section, when it ran or left a Step
	workflow: string | null;
	// the Feedback section, once a Feedback round ran on the branch
	feedback: string | null;
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
	if (p.workflow !== null) parts.push(p.workflow);
	if (p.feedback !== null) parts.push(p.feedback);
	if (p.review !== 'off')
		parts.push(
			`## Review\n\n${p.review ? `${p.review.verdict === 'approve' ? 'Approve' : 'Changes asked'}: ${p.review.summary}` : 'The review did not finish.'}`
		);
	parts.push(costSection(p.spent, p.costs, ref, p.titleOf));
	return `${parts.join('\n\n')}${FOOTER}`;
}

// The total, then what each Ticket cost by kind of work, the Steps after all Tickets, and the review; a kind with no Session is left out.
function costSection(
	spent: number,
	costs: readonly Cost[],
	ref: (id: ItemId) => string,
	titleOf: (id: ItemId) => string | undefined
): string {
	const sum = (ticket: ItemId | null, work: Work) =>
		costs.filter((c) => c.ticket === ticket && c.work === work).reduce((n, c) => n + c.usd, 0);
	const has = (ticket: ItemId | null, work: Work) =>
		costs.some((c) => c.ticket === ticket && c.work === work);
	// a Ticket's Steps are the ones after it; the ones after all Tickets log no Ticket
	const tickets = [...new Set(costs.flatMap((c) => (c.ticket === null ? [] : [c.ticket])))];
	const lines = tickets.map((id) => {
		const kinds: [string, Work][] = [
			['build', 'build'],
			['fix', 'fix'],
			['Steps', 'steps']
		];
		const parts = kinds
			.filter(([, w]) => has(id, w))
			.map(([name, w]) => `${name} ${dollars(sum(id, w))}`);
		const title = titleOf(id);
		return `- ${ref(id)}${title === undefined ? '' : ` ${title}`}: ${parts.join(', ')}`;
	});
	if (has(null, 'steps')) lines.push(`- Steps after all Tickets: ${dollars(sum(null, 'steps'))}`);
	if (has(null, 'feedback')) lines.push(`- Feedback: ${dollars(sum(null, 'feedback'))}`);
	if (has(null, 'review')) lines.push(`- Review: ${dollars(sum(null, 'review'))}`);
	const head = `## Cost\n\nEstimated cost of this run: ${dollars(spent)}.`;
	return lines.length === 0 ? head : `${head}\n\n${lines.join('\n')}`;
}

const START = 80;

// A piece of feedback as a list names it: its id, where it was given, and the start of what it said.
function feedbackLine(f: Feedback): string {
	const first = Array.from(f.body.trim().split('\n')[0] ?? '');
	const start = first.slice(0, START).join('') + (first.length > START ? '…' : '');
	return `\`${f.id}\`, ${feedbackPlace(f)}${start === '' ? '' : ` ("${start}")`}`;
}

function unansweredList(left: readonly Unanswered[]): string {
	return left.map((u) => `- ${feedbackLine(u.feedback)}: ${u.why}`).join('\n');
}

// What a Feedback round left a person to answer: the round thrown away and why, or what it did not answer.
function unansweredText(end: FeedbackEnd): string {
	if (end.kind === 'committed') {
		return `The Feedback round answered ${pieces(end.answered.length)} in ${end.sha} and left this unanswered:\n\n${unansweredList(end.left)}`;
	}
	const tail = end.tail === undefined ? '' : `\n\n\`\`\`\n${end.tail}\n\`\`\``;
	return `The Feedback round was thrown away, so this feedback is still unanswered: ${end.why}.${tail}\n\n${unansweredList(end.left)}`;
}

// The Feedback rounds on the branch, and what this run's round did.
function feedbackSection(
	total: { readonly rounds: number; readonly costUsd: number },
	end: FeedbackEnd | null
): string | null {
	if (total.rounds === 0) return null;
	const rounds = `${String(total.rounds)} Feedback round${total.rounds === 1 ? '' : 's'}`;
	const head = `## Feedback\n\nNightjar ran ${rounds} on this pull request, at an estimated ${dollars(total.costUsd)}.`;
	if (end === null) return head;
	if (end.kind === 'thrown') {
		return `${head}\n\nThis run's round was thrown away: ${end.why}.\n\n${unansweredList(end.left)}`;
	}
	const answered = end.answered.map((a) => `- ${feedbackLine(a.feedback)}`).join('\n');
	const left = end.left.length === 0 ? '' : `\n\nLeft unanswered:\n\n${unansweredList(end.left)}`;
	return `${head}\n\nThis run answered, in ${end.sha}:\n\n${answered}${left}`;
}

function reviewComment(review: Review): string {
	const issues = review.issues
		.map((i) => `- \`${i.file}${i.line ? `:${String(i.line)}` : ''}\`: ${i.problem}`)
		.join('\n');
	return `**Nightjar review: ${review.verdict === 'approve' ? 'approve' : 'changes'}**\n\n${review.summary}${issues ? `\n\n${issues}` : ''}${FOOTER}`;
}
