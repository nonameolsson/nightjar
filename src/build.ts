// The build loop: one Feature from the Go to a draft pull request, through the Tracker and Code host seams alone.
import type { RunCheck } from './check.js';
import type { CodeHost, NightjarDraft, Pull } from './code-host.js';
import { envOf, type CodingAgent } from './coding-agent.js';
import { DEFAULT_PULL_CHECKS } from './config.js';
import { pullChecksReport } from './gate.js';
import type { Env } from './git.js';
import { DEFAULT_DAILY_USD } from './person-config.js';
import { nextTicket, progress, waiting, type Waiting } from './plan.js';
import { failingLine, withPullRound, type PullRound } from './pull-checks-section.js';
import { questionRounds, questionsComment, type Question, type Review } from './prompt.js';
import type { Serve } from './serve.js';
import {
	featureAfterRunStep,
	featureStopStep,
	pullChecksStep,
	stoppedStep,
	ticketStep,
	type TicketHandBack
} from './next-step.js';
import type { Signal, SignalNames } from './signals.js';
import type { Entry, Spend } from './spend.js';
import type { Doing, StatusReport, TicketProgress } from './status.js';
import type { Comment, Feature, ItemId, Ticket, Tracker } from './tracker.js';
import {
	SESSION_TRAILER,
	TRAILER_PREFIX,
	branchFor,
	type OpenWorktree,
	type Worktree
} from './worktree.js';
import {
	chooseWorkflow,
	openWorkflow,
	type FixEnd,
	type FixWork,
	type Halt,
	type WorkflowConfig,
	type WorkflowRun,
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
	// how many Pull-check fix rounds one pull request may get, counted from its branch's trailers
	readonly pullFixRounds: number;
	// the most one Pull-check fix round may cost and run, its check's fix rounds too
	readonly pullFixUsd: number;
	readonly pullFixMinutes: number;
}

export const LIMITS: Limits = {
	ticketUsd: 15,
	ticketMinutes: 60,
	fixRounds: 3,
	reviewUsd: 3,
	reviewMinutes: 10,
	questionRounds: 2,
	dailyUsd: DEFAULT_DAILY_USD,
	pullFixRounds: DEFAULT_PULL_CHECKS.fixRounds,
	pullFixUsd: DEFAULT_PULL_CHECKS.fixUsd,
	pullFixMinutes: DEFAULT_PULL_CHECKS.fixMinutes
};

// What factory.json's pullChecks says of the pass's limits.
interface PullFixSettings {
	readonly fixRounds?: number | undefined;
	readonly fixUsd?: number | undefined;
	readonly fixMinutes?: number | undefined;
}

// The Pull-check limits factory.json sets, each one it leaves out at its default.
export function pullFixLimits(
	pullChecks: PullFixSettings | undefined
): Pick<Limits, 'pullFixRounds' | 'pullFixUsd' | 'pullFixMinutes'> {
	return {
		pullFixRounds: pullChecks?.fixRounds ?? LIMITS.pullFixRounds,
		pullFixUsd: pullChecks?.fixUsd ?? LIMITS.pullFixUsd,
		pullFixMinutes: pullChecks?.fixMinutes ?? LIMITS.pullFixMinutes
	};
}

export interface Deps {
	readonly tracker: Tracker;
	readonly codeHost: CodeHost;
	readonly codingAgent: CodingAgent;
	readonly runCheck: RunCheck;
	// the worktree setup command, run through the same shell as the check
	readonly runSetup: RunCheck;
	// starts a Workflow's serve command
	readonly serve: Serve;
	// records each Session's cost and answers for the caps
	readonly spend: Spend;
	// opens the Feature's worktree: real git, or in memory
	readonly openWorktree: OpenWorktree;
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
	readonly signals: SignalNames;
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

export const FOOTER = '\n\n---\n_Built by Nightjar._';

// A comment for a person: what happened, then what they do next.
const withNext = (body: string, step: string) => `${body}\n\n${step}${FOOTER}`;

const dollars = (n: number) => `$${n.toFixed(2)}`;
const hash = (id: ItemId) => `#${id}`;

type LogEntry = Omit<Entry, 'at' | 'repo' | 'feature' | 'branch'>;

// The kind of work a Session's cost is split under in the pull request; a Step's fix rounds belong to 'steps'.
type Work = 'build' | 'fix' | 'steps' | 'review' | 'pullChecks';

// What this run spent on one kind of work, after one Ticket or, with no Ticket, after all of them.
interface Cost {
	readonly ticket: ItemId | null;
	readonly work: Work;
	readonly usd: number;
}

const workOf = (step: Entry['step']): Work => (step === 'step' ? 'steps' : step);

// What building one Ticket left the run to do next.
type Step = { readonly kind: 'next' } | Halt | { readonly kind: 'red'; readonly tail: string };

const NEXT: Step = { kind: 'next' };

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
			waiting(tickets, new Set()),
			setup.signals
		);
	}
	const tree = await deps.openWorktree(
		setup.root,
		setup.worktrees,
		branch,
		setup.baseBranch,
		setup.env
	);
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
				waiting(tickets, built),
				setup.signals
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
	left: Waiting[],
	signals: SignalNames
): Promise<FeatureOutcome> {
	deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why });
	await deps.tracker.removeSignal(id, 'working');
	await deps.tracker.addSignal(id, 'needsInfo');
	await deps.tracker.comment(id, withNext(comment, featureStopStep(signals)));
	return { kind: 'nothing', waiting: left };
}

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
	private readonly costs: Cost[] = [];
	private featureComments: Comment[] = [];
	// the Feature's Workflow, which runs its own Steps
	private steps: WorkflowRun | null = null;
	// what the status file shows now, so a Ticket built can change its Tickets alone
	private shown: Doing | null = null;
	// when the Feature's build began, and when the session now running did
	private readonly startedAt: Date;
	private sessionStartedAt: Date;

	constructor(
		private readonly deps: Deps,
		private readonly setup: Setup,
		private readonly feature: Feature,
		private readonly tree: Worktree,
		private readonly tickets: Ticket[],
		private readonly built: Set<ItemId>,
		private readonly workflow: { readonly name: string; readonly workflow: WorkflowConfig } | null,
		private readonly show: ShowBuilding
	) {
		this.startedAt = deps.now();
		this.sessionStartedAt = this.startedAt;
	}

	private get aborted() {
		return this.setup.signal?.aborted === true;
	}

	async build(): Promise<FeatureOutcome> {
		this.featureComments = await this.trusted(this.feature.id);
		if (this.workflow !== null) this.steps = await this.openSteps(this.workflow);
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
		if (last.kind === 'next' && !this.aborted && whole && this.steps !== null) {
			last = await this.steps.runAt('afterAllTickets', null);
		}
		return this.finish(last);
	}

	private openSteps(workflow: { readonly name: string; readonly workflow: WorkflowConfig }) {
		const { deps } = this;
		return openWorkflow(workflow, {
			codingAgent: deps.codingAgent,
			runCheck: deps.runCheck,
			serve: deps.serve,
			newId: deps.newId,
			say: deps.say,
			setup: this.setup,
			feature: this.feature,
			tree: this.tree,
			fix: (work) => this.fixUntilGreen(work),
			log: (entry) => this.log(entry),
			building: (ticket, session, rounds) => this.building(ticket, 'step', session, rounds),
			dailyPause: () => this.dailyPause(),
			allowance: (cap, spent) => this.deps.spend.allowance(cap, spent),
			aborted: () => this.aborted
		});
	}

	private dailyPause(): string | null {
		return this.deps.spend.dayOver(this.deps.now(), this.setup.limits.dailyUsd);
	}

	private async trusted(id: ItemId): Promise<Comment[]> {
		return (await this.deps.tracker.comments(id)).filter((c) => c.trusted);
	}

	private log(entry: LogEntry, work: Work = workOf(entry.step)) {
		this.costs.push({ ticket: entry.ticket, work, usd: entry.costUsd });
		const at = this.deps.now();
		this.deps.spend.record({
			at: at.toISOString(),
			repo: this.setup.repo,
			feature: this.feature.id,
			branch: this.tree.at.branch,
			durationMs: Math.max(0, at.getTime() - this.sessionStartedAt.getTime()),
			...entry
		});
		this.sessionStartedAt = at;
	}

	// Hands a Ticket to a person: no code kept on the branch, the reason on the Ticket.
	private async handBack(
		ticket: Ticket,
		before: string,
		body: string,
		kind: TicketHandBack,
		why: string
	) {
		const signal: Signal = kind === 'human' ? 'human' : 'needsInfo';
		const { tracker } = this.deps;
		this.deps.status.happened({
			kind: 'needs-info',
			feature: this.feature.id,
			ticket: ticket.id,
			why
		});
		const side = await this.tree.discard(before, ticket.id);
		const kept = side ? `\n\nThe attempt is kept on branch \`${side}\`.` : '';
		await tracker.comment(
			ticket.id,
			withNext(`${body}${kept}`, ticketStep(this.setup.signals, kind))
		);
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
					'retry',
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
			await this.handBack(ticket, before, questionsComment(questions, round), 'answer', asked);
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
				'retry',
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
		return this.steps === null ? NEXT : this.steps.runAt('afterEachTicket', ticket);
	}

	private fixUntilGreen(o: FixWork): Promise<FixEnd> {
		return fixUntilGreen(
			{
				deps: this.deps,
				setup: this.setup,
				tree: this.tree,
				building: (ticket, session, rounds) => this.building(ticket, 'fix', session, rounds),
				log: (entry, work) => this.log(entry, work)
			},
			o
		);
	}

	private building(
		ticket: ItemId | null,
		step: 'build' | 'fix' | 'step',
		session: string,
		rounds: { readonly round: number; readonly rounds: number }
	) {
		this.sessionStartedAt = this.deps.now();
		this.shown = this.show({
			ticket,
			step,
			...rounds,
			session,
			tickets: progress(this.tickets, this.built, ticket)
		});
		this.deps.status.doing(this.shown);
	}

	private async finish(last: Step): Promise<FeatureOutcome> {
		const { tracker, codeHost } = this.deps;
		const id = this.feature.id;
		const left = waiting(this.tickets, this.built);
		let paused = last.kind === 'paused' ? last.why : null;
		await tracker.removeSignal(id, 'working');
		if (this.aborted || last.kind === 'aborted') {
			await tracker.comment(
				id,
				withNext('The Nightjar run was stopped by a person.', stoppedStep(this.setup.signals))
			);
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
				withNext(
					`Nightjar built nothing for this Feature.\n\n${waitingList(left)}`,
					featureAfterRunStep(this.setup.signals, { waiting: left.length > 0, red: false })
				)
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
		const ids = done.map((t) => t.id);
		const workflow = this.steps?.section(ids, (n) => tracker.reference(n).text) ?? null;
		const body = pullBody({
			tracker,
			feature: this.feature,
			check: this.setup.check,
			complete,
			done,
			left,
			red,
			review,
			spent: this.costs.reduce((n, c) => n + c.usd, 0),
			costs: this.costs,
			titleOf: (id) => this.tickets.find((t) => t.id === id)?.title,
			paused,
			workflow
		});
		const pull = await this.openDraft(body);
		const linked = [...(complete ? [id] : []), ...done.map((t) => t.id)];
		await codeHost.placeReferences(
			pull,
			linked.map((n) => tracker.reference(n))
		);
		if (review !== 'off' && review) await codeHost.comment(pull, reviewComment(review));
		this.deps.say(`${hash(id)}: draft pull request ${pull.url}`);
		this.deps.status.happened({
			kind: 'pull',
			feature: id,
			title: this.feature.title,
			url: pull.url,
			startedAt: this.startedAt.toISOString(),
			tickets: {
				built: this.tickets.filter((t) => this.built.has(t.id)).length,
				total: this.tickets.length
			}
		});
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
				withNext(
					`Nightjar opened ${pull.url}, and this Feature still needs a person.\n\n${failing}${waitingList(left)}`,
					featureAfterRunStep(this.setup.signals, { waiting: left.length > 0, red: red !== null })
				)
			);
		}
		return { kind: 'pull', pull, built: [...this.built], waiting: left };
	}

	// The Go back, so a later run goes on from the branch.
	private async pause(why: string): Promise<void> {
		await this.deps.tracker.addSignal(this.feature.id, 'go');
		this.deps.say(`paused: ${why}`);
		this.deps.status.doing({ kind: 'paused', why, until: null });
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

// What the fix rounds work with: the run's seams and worktree, and how the run shows and logs a round.
interface FixContext {
	readonly deps: Deps;
	readonly setup: Setup;
	readonly tree: Worktree;
	readonly building: (
		ticket: ItemId | null,
		session: string,
		rounds: { readonly round: number; readonly rounds: number }
	) => void;
	readonly log: (entry: LogEntry, work: Work) => void;
}

// Fix rounds while the check fails, each in the session that built the work; `cap` is the most the whole piece of work may cost.
async function fixUntilGreen(ctx: FixContext, o: FixWork): Promise<FixEnd> {
	const { deps, setup, tree } = ctx;
	const { limits, check: command } = setup;
	const summaries: string[] = [];
	const work: Work = o.of.kind === 'step' ? 'steps' : 'fix';
	let { check, spent } = o;
	for (let round = 1; !check.ok && round <= limits.fixRounds; round += 1) {
		const { usd: budget, enough } = deps.spend.allowance(o.cap, spent);
		if (!enough) break;
		const minutes = minutesLeft(deps.now, o.deadline);
		if (minutes !== undefined && minutes <= 0) break;
		deps.say(`${o.name}: the check fails, fix round ${String(round)}`);
		ctx.building(o.ticket, o.sessionId, { round, rounds: limits.fixRounds });
		const got = await deps.codingAgent.fix({
			kind: 'fix',
			at: tree.at,
			of: o.of,
			resume: o.sessionId,
			round,
			tail: check.tail,
			budgetUsd: budget,
			...(minutes === undefined ? {} : { minutes })
		});
		spent += got.costUsd;
		const entry = { ticket: o.ticket, step: 'fix' as const, session: o.sessionId };
		if (got.kind === 'paused') {
			ctx.log({ ...entry, costUsd: got.costUsd, outcome: `paused: ${got.why}` }, work);
			return { check, spent, summaries, halt: { kind: 'paused', why: got.why } };
		}
		// the ledger names a fix round that failed or was stopped as one that gave up
		const gaveUp = got.kind !== 'fixed';
		ctx.log(
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
		check = await deps.runCheck(command, tree.at.folder, envOf(setup));
	}
	// a stop during the check, which no Session reports
	if (setup.signal?.aborted === true) {
		return { check, spent, summaries, halt: { kind: 'aborted' } };
	}
	return { check, spent, summaries };
}

// What is left of the minutes before `deadline`; nothing for work without one.
const minutesLeft = (now: () => Date, deadline: number | undefined) =>
	deadline === undefined ? undefined : (deadline - now().getTime()) / 60_000;

// A draft pull request the revisit pass takes: red, finished, unengaged, and on a Feature of the person's that holds no Signal.
export interface RedDraft {
	readonly draft: NightjarDraft;
	// the Feature its body's marker names
	readonly feature: ItemId;
}

export type PullFixOutcome =
	// a green fix pushed to the branch as its `round`th Pull-check fix, which cost `usd`
	| {
			readonly kind: 'fixed';
			readonly pull: Pull;
			readonly round: number;
			readonly summary: string;
			readonly usd: number;
	  }
	// nothing pushed: the work, if any, is kept on an attempt branch, and the Feature is handed to a person
	| {
			readonly kind: 'gaveUp';
			readonly pull: Pull;
			readonly round: number;
			readonly why: string;
			readonly usd: number;
	  }
	// the pull request has had its `rounds` fix rounds: no Session, and the Feature is handed to a person
	| { readonly kind: 'atLimit'; readonly pull: Pull; readonly rounds: number }
	// the pull request is not Nightjar's to fix after all; nothing was done
	| { readonly kind: 'skipped'; readonly why: string }
	| { readonly kind: 'paused'; readonly why: string }
	| { readonly kind: 'stopped' };

// One Pull-check fix round on a red draft pull request: a Session that resumes the head commit's, the repo's check with the usual fix rounds, and a new commit pushed only when it is green. No review and no Step runs after it.
export async function fixPullChecks(
	deps: Deps,
	setup: Setup,
	red: RedDraft
): Promise<PullFixOutcome> {
	const { tracker } = deps;
	const { draft } = red;
	const { pull } = draft;
	const day = deps.spend.dayOver(deps.now(), setup.limits.dailyUsd);
	if (day !== null) return { kind: 'paused', why: day };
	const feature = await tracker.feature(red.feature);
	const tree = await deps.openWorktree(
		setup.root,
		setup.worktrees,
		draft.branch,
		setup.baseBranch,
		setup.env
	);
	const skip = (why: string): PullFixOutcome => {
		deps.say(`${pull.url}: left alone, ${why}`);
		return { kind: 'skipped', why };
	};
	if (!(await tree.toRemote())) return skip('its branch here holds commits the Code host lacks');
	const trailers = await tree.headTrailers();
	if (![...trailers.keys()].some((k) => k.startsWith(TRAILER_PREFIX))) {
		return skip("its head commit is not Nightjar's");
	}
	const session = trailers.get(SESSION_TRAILER);
	if (session === undefined) return skip('its head commit names no Session to resume');
	// counted from the branch, so neither a new run nor taking needs a person off resets it
	const used = await tree.pullFixes();
	const rounds = setup.limits.pullFixRounds;
	if (used >= rounds) {
		const why = `it has had its ${String(rounds)} Pull-check fix round${rounds === 1 ? '' : 's'}`;
		deps.say(`${hash(feature.id)}: the Pull checks of ${pull.url} fail, and ${why}`);
		await handOver(deps, setup, feature.id, draft, why, draft.body);
		return { kind: 'atLimit', pull, rounds };
	}
	const round = used + 1;
	deps.say(`${hash(feature.id)}: the Pull checks of ${pull.url} fail, fix ${String(round)}`);
	await tracker.addSignal(feature.id, 'working');
	let got: PullFixOutcome;
	try {
		got = await pullFixRound(deps, setup, { feature, tree, draft, session, round });
		// every round that ran says so in the body, the one that gave up too
		const ran = (r: Pick<PullRound, 'outcome' | 'summary' | 'usd'>) =>
			withPullRound(draft.body, { round, failed: draft.checks.failed, ...r });
		if (got.kind === 'fixed') {
			await deps.codeHost.editBody(
				pull,
				ran({ outcome: 'pushed', summary: got.summary, usd: got.usd })
			);
		} else if (got.kind === 'gaveUp') {
			const why = `Pull-check fix ${String(round)} gave up: ${got.why}`;
			const body = ran({ outcome: 'gave up', summary: `It gave up: ${got.why}.`, usd: got.usd });
			await handOver(deps, setup, feature.id, draft, why, body);
		}
	} finally {
		await tracker.removeSignal(feature.id, 'working');
	}
	return got;
}

const HANDED_OVER = '<!-- nightjar-pull-checks: handed to a person -->';

// Whether the revisit pass handed this pull request to a person; a normal build rewrites the body, and so takes the mark off.
export function handedOver(body: string): boolean {
	return body.includes(HANDED_OVER);
}

// The body with the hidden mark that the pass handed the pull request to a person.
export function markHandedOver(body: string): string {
	return handedOver(body) ? body : `${body}\n\n${HANDED_OVER}`;
}

// The Feature is a person's now: needs a person on it, a comment naming the pull request and its failing Pull checks, and a mark in the body so the pass leaves it alone once the Signal comes off.
async function handOver(
	deps: Deps,
	setup: Setup,
	feature: ItemId,
	draft: NightjarDraft,
	why: string,
	// the pull request body as it is to stay, before the mark
	body: string
): Promise<void> {
	const { pull } = draft;
	await deps.tracker.addSignal(feature, 'human');
	const failing = draft.checks.failed.map(failingLine);
	const comment = `Nightjar could not make the Pull checks of ${pull.url} green: ${why}.\n\nFailing Pull checks:\n\n${failing.join('\n')}`;
	await deps.tracker.comment(feature, withNext(comment, pullChecksStep(setup.signals)));
	await deps.codeHost.editBody(pull, markHandedOver(body));
	deps.say(`${hash(feature)}: handed to a person, ${why}`);
}

async function pullFixRound(
	deps: Deps,
	setup: Setup,
	o: {
		feature: Feature;
		tree: Worktree;
		draft: NightjarDraft;
		session: string;
		round: number;
	}
): Promise<PullFixOutcome> {
	const { feature, tree, draft, session, round } = o;
	const { pull } = draft;
	const show = buildingOf(feature, deps.now);
	let sessionStartedAt = deps.now();
	// the whole round, the check's own fix rounds too, shows as the Pull-check fix it is
	const building = () => {
		sessionStartedAt = deps.now();
		deps.status.doing(
			show({
				ticket: null,
				step: 'pullChecks',
				round,
				rounds: setup.limits.pullFixRounds,
				session
			})
		);
	};
	const log = (entry: LogEntry) => {
		const at = deps.now();
		deps.spend.record({
			at: at.toISOString(),
			repo: setup.repo,
			feature: feature.id,
			branch: tree.at.branch,
			durationMs: Math.max(0, at.getTime() - sessionStartedAt.getTime()),
			...entry,
			step: 'pullChecks'
		});
		sessionStartedAt = at;
	};
	const name = `Pull-check fix ${String(round)}`;
	const before = await tree.head();
	const gaveUp = async (why: string, usd: number): Promise<PullFixOutcome> => {
		const side = await tree.discard(before, `pull-fix-${String(round)}`);
		deps.say(
			`${hash(feature.id)}: ${name} gave up: ${why}${side ? `; the attempt is kept on ${side}` : ''}`
		);
		return { kind: 'gaveUp', pull, round, why, usd };
	};
	const halted = async (halt: Halt): Promise<PullFixOutcome> => {
		await tree.discard(before, `pull-fix-${String(round)}`);
		return halt.kind === 'paused' ? { kind: 'paused', why: halt.why } : { kind: 'stopped' };
	};

	building();
	const { pullFixUsd: cap, pullFixMinutes: minutes } = setup.limits;
	const deadline = deps.now().getTime() + minutes * 60_000;
	// why the round stopped short of a green check: one of its own caps, else the fix rounds ran out
	const stillRed = (spent: number) => {
		if (!deps.spend.allowance(cap, spent).enough) return `it reached its cap of ${dollars(cap)}`;
		if (deps.now().getTime() >= deadline) return `it ran past its ${String(minutes)} minutes`;
		return `\`${setup.check}\` still fails after the fix rounds`;
	};
	const got = await deps.codingAgent.fix({
		kind: 'fix',
		at: tree.at,
		of: { kind: 'pullChecks' },
		resume: session,
		round,
		tail: pullChecksReport(draft.checks.failed),
		budgetUsd: cap,
		minutes
	});
	const entry = { ticket: null, step: 'pullChecks' as const, session, costUsd: got.costUsd };
	switch (got.kind) {
		case 'paused':
			log({ ...entry, outcome: `paused: ${got.why}` });
			return halted(got);
		case 'aborted':
			log({ ...entry, outcome: 'stopped by a person' });
			return halted(got);
		case 'failed':
			log({ ...entry, outcome: `pull checks ${String(round)} failed: ${got.why}` });
			return gaveUp(got.why, got.costUsd);
		case 'gaveUp':
			log({ ...entry, outcome: `pull checks ${String(round)} gave up` });
			return gaveUp('the Session could not fix the Pull checks', got.costUsd);
		case 'fixed':
			log({ ...entry, outcome: `pull checks ${String(round)}` });
	}
	const first = await deps.runCheck(setup.check, tree.at.folder, envOf(setup));
	const fixed = await fixUntilGreen(
		{
			deps,
			setup,
			tree,
			building,
			log: (e) => log(e)
		},
		{
			ticket: null,
			name,
			sessionId: session,
			cap,
			spent: got.costUsd,
			check: first,
			of: { kind: 'build' },
			deadline
		}
	);
	if (fixed.halt !== undefined) return halted(fixed.halt);
	if (!fixed.check.ok) return gaveUp(stillRed(fixed.spent), fixed.spent);
	const summary = [got.summary, ...fixed.summaries].join('\n\n');
	if (!(await tree.commitPullFix(round, summary, session))) {
		return gaveUp('the Session changed no file', fixed.spent);
	}
	await deps.codeHost.push(tree.at.folder, tree.at.branch);
	deps.say(`${hash(feature.id)}: ${name} pushed to ${pull.url}`);
	return { kind: 'fixed', pull, round, summary, usd: fixed.spent };
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
	if (p.review !== 'off')
		parts.push(
			`## Review\n\n${p.review ? `${p.review.verdict === 'approve' ? 'Approve' : 'Changes asked'}: ${p.review.summary}` : 'The review did not finish.'}`
		);
	parts.push(costSection(p.spent, p.costs, ref, p.titleOf));
	parts.push(featureMarker(p.feature.id));
	return `${parts.join('\n\n')}${FOOTER}`;
}

const MARKER = /<!-- nightjar-feature: (\S+) -->/;

// The hidden line that names the Feature a pull request belongs to.
export function featureMarker(id: ItemId): string {
	return `<!-- nightjar-feature: ${id} -->`;
}

// The Feature id a pull request body names; nothing for a body written without the marker.
export function featureOfBody(body: string): string | undefined {
	return MARKER.exec(body)?.[1];
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
	if (has(null, 'review')) lines.push(`- Review: ${dollars(sum(null, 'review'))}`);
	const head = `## Cost\n\nEstimated cost of this run: ${dollars(spent)}.`;
	return lines.length === 0 ? head : `${head}\n\n${lines.join('\n')}`;
}

function reviewComment(review: Review): string {
	const issues = review.issues
		.map((i) => `- \`${i.file}${i.line ? `:${String(i.line)}` : ''}\`: ${i.problem}`)
		.join('\n');
	return `**Nightjar review: ${review.verdict === 'approve' ? 'approve' : 'changes'}**\n\n${review.summary}${issues ? `\n\n${issues}` : ''}${FOOTER}`;
}
