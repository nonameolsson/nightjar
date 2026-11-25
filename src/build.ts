// The build loop: one Feature from the Go to a draft pull request, through the Tracker and Code host seams alone.
import type { RunCheck } from './check.js';
import type { CodeHost, NightjarDraft, Pull } from './code-host.js';
import {
	envOf,
	type BuildOutcome,
	type CodingAgent,
	type FixOutcome,
	type ReviewOutcome
} from './coding-agent.js';
import { DEFAULT_PULL_CHECKS, DEFAULT_REVIEW_FIX_ROUNDS } from './config.js';
import { pullChecksReport } from './gate.js';
import {
	feedbackRound,
	feedbackRounds,
	feedbackSection,
	replyText,
	thrownAwayComment,
	type FeedbackRoundEnd,
	type Unanswered
} from './feedback-round.js';
import { FOOTER, withFooter } from './footer.js';
import { baseOf, botPullOf } from './base-line.js';
import type { Env } from './git.js';
import { noteFor, type Logbook, type Note } from './logbook.js';
import { DEFAULT_DAILY_USD } from './person-config.js';
import { nextTicket, progress, waiting, type Waiting } from './plan.js';
import { conflicts, withConflicts, withoutConflicts } from './conflicts-section.js';
import { why } from './say.js';
import { failingLine, withPullRound, type PullRound } from './pull-checks-section.js';
import {
	issueLine,
	questionRounds,
	questionsComment,
	type Declined,
	type Question,
	type Review
} from './prompt.js';
import type { Serve } from './serve.js';
import { NOTES_FOLDER } from './settings.js';
import {
	featureAfterRunStep,
	featureStopStep,
	feedbackStep,
	nextStepText,
	noteStep,
	pullChecksStep,
	pushRejectedStep,
	reviewStep,
	stoppedStep,
	ticketStep,
	type NextStep,
	type TicketHandBack
} from './next-step.js';
import { markPublished, publishedByNightjar, publishMark } from './publish.js';
import type { Signal, SignalNames } from './signals.js';
import { ticketFaults } from './ticket-contract.js';
import { retryPassing, TRIES } from './retry.js';
import { reviewRound } from './review-round.js';
import { reviewSection, type ReviewSession } from './review-section.js';
import type { Entry, LogEntry, Spend } from './spend.js';
import type { Doing, StatusReport, TicketProgress } from './status.js';
import { dollars } from './view-text.js';
import type { Comment, Feature, ItemId, Ticket, Tracker } from './tracker.js';
import {
	SESSION_TRAILER,
	TRAILER_PREFIX,
	branchFor,
	type OpenWorktree,
	type Worktree
} from './worktree.js';
import {
	DIFF_CHARS,
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
	// each Feature's Logbook, where every decision between its Sessions is written
	readonly logbook: Logbook;
	// opens the Feature's worktree: real git, or in memory
	readonly openWorktree: OpenWorktree;
	readonly now: () => Date;
	// waits between the tries of a Session that failed for a passing reason; a spec swaps it for a stand-in
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly newId: () => string;
	// whether the Coding agent still has the Session of this id on this machine, to resume
	readonly sessionExists: (id: string) => boolean;
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
		// how many Review rounds a build gets; DEFAULT_REVIEW_FIX_ROUNDS when it says nothing
		readonly fixRounds?: number;
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
			// why the run paused after it opened the pull request, so the loop waits before it builds again
			readonly paused?: string;
	  }
	| { readonly kind: 'nothing'; readonly waiting: Waiting[] }
	// the run stopped for a reason of the machine or the plan, not of the Feature; it goes on later
	| { readonly kind: 'paused'; readonly why: string }
	| { readonly kind: 'stopped' }
	// a person pushed to the branch first: the build's work waits on the local branch `side`, and the Feature is the person's
	| { readonly kind: 'diverged'; readonly side: string };

// A comment for a person: what happened, then what they do next.
const withNext = (body: string, step: NextStep) => `${body}\n\n${nextStepText(step)}${FOOTER}`;

const hash = (id: ItemId) => `#${id}`;

// The kind of work a Session's cost is split under in the pull request; a Step's fix rounds belong to 'steps', a Feedback round's to 'feedback', a Review round's to 'reviewRound'.
type Work = 'build' | 'fix' | 'steps' | 'review' | 'pullChecks' | 'feedback' | 'reviewRound';

// What this run spent on one kind of work, after one Ticket or, with no Ticket, after all of them.
interface Cost {
	readonly ticket: ItemId | null;
	readonly work: Work;
	readonly usd: number;
}

const workOf = (step: Entry['step']): Work => (step === 'step' ? 'steps' : step);

// What building one Ticket left the run to do next.
type Step =
	| { readonly kind: 'next' }
	| Halt
	| { readonly kind: 'red'; readonly tail: string }
	| { readonly kind: 'repeated'; readonly why: string; readonly tickets: readonly ItemId[] };

// How many Tickets in a row failing with the same lasting reason stop the run.
const REPEATED_FAILURES = 3;

const NEXT: Step = { kind: 'next' };

// A step shown with no round of its own.
const NO_ROUND = { round: null, rounds: null };

// why work a person stopped was thrown away
const STOPPED = 'stopped by a person';

const haltWhy = (halt: Halt) => (halt.kind === 'paused' ? `paused: ${halt.why}` : STOPPED);

// A build with no Go, which a trusted request for changes on the Feature's pull request started: its id, which the Feedback round's commit names.
export interface Asked {
	readonly asked: string;
}

export async function buildFeature(
	deps: Deps,
	setup: Setup,
	id: ItemId,
	started?: Asked
): Promise<FeatureOutcome> {
	const { tracker } = deps;
	const feature = await tracker.feature(id);
	const branch = branchFor(feature.id, feature.title);
	deps.say(`${hash(id)} ${feature.title}: building on ${branch}`);
	// the Feature's start, before anything else reads the clock
	const show = buildingOf(feature, deps.now);
	const note = noteFor(deps.logbook, feature.id, deps.now);
	const signals = signalsOf(tracker, feature.id, note);
	const chosen = chooseWorkflow(setup, feature.body);
	note({
		kind: 'buildStarted',
		by: started === undefined ? 'go' : 'feedback',
		...(started === undefined ? {} : { asked: started.asked }),
		branch,
		workflow: chosen.kind === 'workflow' ? chosen.name : null
	});
	await signals.on('working');
	await signals.off('go');
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
	// a run that died could not take working off its Ticket; the claim does, before anything is built. A lone issue is its own Ticket, and its working is the Feature's, just added.
	for (const ticket of tickets) {
		if (ticket.id !== id && ticket.signals.includes('working')) {
			await signals.off('working', ticket.id);
		}
	}
	if (chosen.kind === 'refused') {
		const why = `its Workflow cannot be used: ${chosen.why}`;
		return needsInfoStop(
			deps,
			{ id, note, signals },
			why,
			`Nightjar built nothing: ${chosen.why}`,
			waiting(tickets, new Set()),
			setup.signals
		);
	}
	// a botPulls Source's Feature is built on the bot's branch, so the new versions are in it
	const base = baseOf(feature.body);
	if (base !== null && 'fault' in base) {
		return needsInfoStop(
			deps,
			{ id, note, signals },
			base.fault,
			`Nightjar built nothing: ${base.fault}.`,
			waiting(tickets, new Set()),
			setup.signals
		);
	}
	const tree = await deps.openWorktree(
		setup.root,
		setup.worktrees,
		branch,
		base?.branch ?? setup.baseBranch,
		setup.env
	);
	const built = await tree.built();
	// the Tickets are planned once the branch says which are built
	deps.status.doing(settingUp(progress(tickets, built, null)));
	if (setup.setupCommand !== undefined && !(await tree.isSetUp())) {
		const command = setup.setupCommand;
		deps.say(`${hash(id)}: setup: ${command}`);
		const got = await deps.runSetup(command, tree.at.folder, envOf(setup));
		note({ kind: 'setup', command, ok: got.ok });
		if (!got.ok) {
			const why = `the setup command \`${command}\` failed`;
			return needsInfoStop(
				deps,
				{ id, note, signals },
				why,
				`Nightjar built nothing: ${why} in the worktree.\n\n\`\`\`\n${got.tail}\n\`\`\``,
				waiting(tickets, built),
				setup.signals
			);
		}
		await tree.markSetUp();
	}
	const workflow = chosen.kind === 'workflow' ? chosen : null;
	const run = new FeatureRun(deps, setup, feature, tree, tickets, built, workflow, show, started);
	return run.build();
}

// A Feature stopped before it built anything, with the reason on it; a later Go builds it again.
async function needsInfoStop(
	deps: Deps,
	of: { readonly id: ItemId; readonly note: Note; readonly signals: FeatureSignals },
	why: string,
	comment: string,
	left: Waiting[],
	names: SignalNames
): Promise<FeatureOutcome> {
	const { id, note, signals } = of;
	const next = featureStopStep(names);
	deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why, next });
	note({ kind: 'handed', to: 'needsInfo', why });
	await signals.off('working');
	await signals.on('needsInfo');
	await deps.tracker.comment(id, withNext(comment, next));
	return { kind: 'nothing', waiting: left };
}

// The Signal calls on a Feature and its Tickets, each written to the Feature's Logbook once the Tracker has it; with `ticket`, the Signal is that Ticket's.
interface FeatureSignals {
	on(signal: Signal, ticket?: ItemId): Promise<void>;
	off(signal: Signal, ticket?: ItemId): Promise<void>;
}

function signalsOf(tracker: Tracker, feature: ItemId, note: Note): FeatureSignals {
	const set = async (signal: Signal, on: boolean, ticket?: ItemId) => {
		const item = ticket ?? feature;
		await (on ? tracker.addSignal(item, signal) : tracker.removeSignal(item, signal));
		note({ kind: 'signal', signal, on, ...(ticket === undefined ? {} : { ticket }) });
	};
	return {
		on: (signal, ticket) => set(signal, true, ticket),
		off: (signal, ticket) => set(signal, false, ticket)
	};
}

type Building = Extract<Doing, { kind: 'building' }>;
type ShowBuilding = (
	at: Pick<Building, 'ticket' | 'step' | 'round' | 'rounds' | 'session' | 'tickets'> &
		Partial<Pick<Building, 'retry'>>
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
	// the test each Ticket's Session said shows its bug, for the pull request
	private readonly tests = new Map<ItemId, string>();
	private featureComments: Comment[] = [];
	// the run's Feedback round that landed, whose feedback gets its replies after the push
	private answered: Extract<FeedbackRoundEnd, { kind: 'answered' }> | null = null;
	// the feedback the run's Feedback round left unanswered, which the pull request lists
	private unanswered: readonly Unanswered[] = [];
	// the Feature's Workflow, which runs its own Steps
	private steps: WorkflowRun | null = null;
	// what the status file shows now, so a Ticket built can change its Tickets alone
	private shown: Doing | null = null;
	// when the Feature's build began, and when the session now running did
	private readonly startedAt: Date;
	private sessionStartedAt: Date;
	// the Tickets handed back in a row with a lasting failure, and why; any other end of a Ticket clears it
	// the reason the Ticket just built failed for, when its failure is lasting
	private lastFailure: string | null = null;
	private streak: { readonly ticket: ItemId; readonly why: string }[] = [];
	// writes the Feature's Logbook, and its Signal calls with it
	private readonly note: Note;
	private readonly signals: FeatureSignals;

	constructor(
		private readonly deps: Deps,
		private readonly setup: Setup,
		private readonly feature: Feature,
		private readonly tree: Worktree,
		private readonly tickets: Ticket[],
		private readonly built: Set<ItemId>,
		private readonly workflow: { readonly name: string; readonly workflow: WorkflowConfig } | null,
		private readonly show: ShowBuilding,
		private readonly started?: Asked
	) {
		this.startedAt = deps.now();
		this.sessionStartedAt = this.startedAt;
		this.note = noteFor(deps.logbook, feature.id, deps.now);
		this.signals = signalsOf(deps.tracker, feature.id, this.note);
	}

	private get aborted() {
		return this.setup.signal?.aborted === true;
	}

	// "note" when the Feature's Workflow writes a note under docs/research/, not code
	private get output(): { readonly output?: 'note' } {
		const output = this.workflow?.workflow.output;
		return output === undefined ? {} : { output };
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
			if (last.kind === 'next') last = this.repeated(ticket, last);
		}
		// the Steps of "all Tickets" run on a Feature whose Tickets are all built
		const whole = this.built.size > 0 && waiting(this.tickets, this.built).length === 0;
		if (last.kind === 'next' && !this.aborted && whole && this.steps !== null) {
			last = await this.steps.runAt('afterAllTickets', null);
		}
		if (last.kind === 'next' && !this.aborted) last = await this.answerFeedback();
		return this.finish(last);
	}

	// One Feedback round when the branch's open pull request has trusted feedback no commit answers yet; one that fails is thrown away and handed to a person, and the run goes on.
	private async answerFeedback(): Promise<Step> {
		const { deps } = this;
		const end = await feedbackRound({
			codeHost: deps.codeHost,
			codingAgent: deps.codingAgent,
			runCheck: deps.runCheck,
			newId: deps.newId,
			say: deps.say,
			setup: this.setup,
			feature: this.feature,
			tree: this.tree,
			dailyPause: () => this.dailyPause(),
			allowance: (cap, spent) => deps.spend.allowance(cap, spent),
			fix: (work) => this.fixFeedback(work),
			log: (entry) => this.log(entry),
			note: this.note,
			building: (session) => this.building(null, 'feedback', session, NO_ROUND),
			...(this.started === undefined ? {} : { asked: this.started.asked })
		});
		switch (end.kind) {
			case 'none':
				return NEXT;
			case 'paused':
			case 'aborted':
				return end;
			case 'answered':
				this.answered = end;
				this.unanswered = end.left;
				return NEXT;
			case 'failed': {
				this.unanswered = end.left;
				const next = feedbackStep(this.setup.signals);
				const why = `its Feedback round was thrown away: ${end.why}`;
				deps.status.happened({
					kind: 'needs-info',
					feature: this.feature.id,
					ticket: null,
					why,
					next
				});
				this.note({ kind: 'handed', to: 'needsInfo', why });
				await this.signals.on('needsInfo');
				await deps.tracker.comment(this.feature.id, withNext(thrownAwayComment(end), next));
				return NEXT;
			}
		}
	}

	// A Feedback round's fix rounds show and are logged as the round they belong to.
	private fixFeedback(o: FixWork): Promise<FixEnd> {
		return fixUntilGreen(
			{
				deps: this.deps,
				setup: this.setup,
				tree: this.tree,
				building: (ticket, session, rounds, attempt) =>
					this.building(ticket, 'feedback', session, rounds, attempt),
				log: (entry) => this.log({ ...entry, step: 'feedback' }),
				note: this.note
			},
			o
		);
	}

	// Each piece of feedback the round answered gets a reply naming its commit, once the commit is pushed.
	private async replyToFeedback(pull: Pull): Promise<void> {
		const { codeHost } = this.deps;
		const round = this.answered;
		if (round === null || codeHost.reply === undefined) return;
		for (const { feedback, note } of round.answered) {
			await codeHost.reply(pull, feedback.id, replyText(round.commit, note));
		}
	}

	private openSteps(workflow: { readonly name: string; readonly workflow: WorkflowConfig }) {
		const { deps } = this;
		return openWorkflow(workflow, {
			codingAgent: deps.codingAgent,
			runCheck: deps.runCheck,
			serve: deps.serve,
			newId: deps.newId,
			sleep: deps.sleep,
			signal: this.setup.signal,
			say: deps.say,
			setup: this.setup,
			feature: this.feature,
			tree: this.tree,
			fix: (work) => this.fixUntilGreen(work),
			log: (entry) => this.log(entry),
			verdict: (report, session) =>
				this.note({
					kind: 'stepVerdict',
					workflow: workflow.name,
					step: report.step.name,
					verdict: report.state,
					...(report.why === undefined ? {} : { why: report.why }),
					...(report.rounds === undefined ? {} : { rounds: report.rounds }),
					left: [...report.left],
					...(report.ticket === null ? {} : { ticket: report.ticket }),
					...(session === undefined ? {} : { session })
				}),
			building: (ticket, session, rounds, attempt) =>
				this.building(ticket, 'step', session, rounds, attempt),
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
		const signal = kind === 'human' ? 'human' : 'needsInfo';
		const next = ticketStep(this.setup.signals, kind);
		this.deps.status.happened({
			kind: 'needs-info',
			feature: this.feature.id,
			ticket: ticket.id,
			why,
			next
		});
		this.note({ kind: 'handed', to: signal, why, ticket: ticket.id });
		const side = await this.throwAway(before, ticket.id, why);
		const kept = side ? `\n\nThe attempt is kept on branch \`${side}\`.` : '';
		await this.deps.tracker.comment(ticket.id, withNext(`${body}${kept}`, next));
		await this.signals.off('ready', ticket.id);
		await this.signals.on(signal, ticket.id);
		const i = this.tickets.indexOf(ticket);
		this.tickets[i] = {
			...ticket,
			signals: [...ticket.signals.filter((s) => s !== 'ready'), signal]
		};
	}

	// Takes the branch back to `before`; what the Ticket's work left is kept on an attempt branch, which the Logbook names with `why`.
	private async throwAway(before: string, ticket: ItemId, why: string): Promise<string | null> {
		const side = await this.tree.discard(before, ticket);
		if (side !== null) this.note({ kind: 'thrownAway', branch: side, why, ticket });
		return side;
	}

	// Remembers how the Ticket ended; three in a row failing for the same lasting reason stop the run.
	private repeated(ticket: Ticket, step: Step): Step {
		const failed = this.lastFailure;
		this.lastFailure = null;
		if (failed === null) {
			this.streak = [];
			return step;
		}
		this.streak = [
			...this.streak.filter((f) => f.why === failed),
			{ ticket: ticket.id, why: failed }
		].slice(-REPEATED_FAILURES);
		if (this.streak.length < REPEATED_FAILURES) return step;
		return { kind: 'repeated', why: failed, tickets: this.streak.map((f) => f.ticket) };
	}

	// The Ticket carries the working Signal from just before its build Session starts until it ends any way: built, handed back, paused or stopped.
	private async buildTicket(ticket: Ticket): Promise<Step> {
		this.note({ kind: 'ticketStarted', ticket: ticket.id });
		const before = await this.tree.head();
		const faults = ticketFaults(ticket.body);
		if (faults.length === 0) await this.signals.on('working', ticket.id);
		try {
			return await this.buildWorking(ticket, before, faults);
		} finally {
			if (faults.length === 0) await this.signals.off('working', ticket.id);
		}
	}

	private async buildWorking(
		ticket: Ticket,
		before: string,
		faults: readonly string[]
	): Promise<Step> {
		if (faults.length > 0) {
			await this.handBack(
				ticket,
				before,
				`Nightjar did not start a Session on this Ticket, because it does not meet the Ticket contract:\n\n${faults.map((f) => `- ${f}`).join('\n')}`,
				'retry',
				`it fails the Ticket contract: ${faults.join(' ')}`
			);
			return NEXT;
		}
		const ticketComments = await this.trusted(ticket.id);
		const prompt = this.workflow?.workflow.prompt;
		const workflow =
			this.workflow !== null && prompt !== undefined ? { name: this.workflow.name, prompt } : null;
		const rounds = {
			round: questionRounds(ticketComments) + 1,
			rounds: this.setup.limits.questionRounds + 1
		};
		const { outcome: got, earlierUsd } = await retryPassing<BuildOutcome>({
			budgetUsd: this.setup.limits.ticketUsd,
			enough: (usd) => this.deps.spend.allowance(usd, 0).enough,
			reset: () => this.tree.revert(before),
			sleep: this.deps.sleep,
			signal: this.setup.signal,
			run: (budgetUsd, attempt) => {
				const sessionId = this.deps.newId();
				this.deps.say(`${hash(ticket.id)} ${ticket.title}: session ${sessionId}`);
				this.building(ticket.id, 'build', sessionId, rounds, attempt);
				return this.deps.codingAgent.build({
					kind: 'build',
					at: this.tree.at,
					sessionId,
					feature: this.feature,
					ticket,
					featureComments: this.featureComments,
					ticketComments,
					built: this.tickets.filter((t) => this.built.has(t.id)),
					...(workflow === null ? {} : { workflow }),
					...this.output,
					budgetUsd
				});
			},
			record: (failed) =>
				this.log({
					ticket: ticket.id,
					step: 'build',
					session: failed.sessionId,
					costUsd: failed.costUsd,
					outcome: `failed: ${failed.why}`,
					failure: 'passing'
				}),
			retrying: (attempt, why) =>
				this.deps.say(
					`${hash(ticket.id)}: ${why}; retrying after a passing fault, try ${String(attempt)} of ${String(TRIES)}`
				)
		});
		const sessionId = got.sessionId;
		const entry = {
			ticket: ticket.id,
			step: 'build' as const,
			session: sessionId,
			costUsd: got.costUsd
		};

		switch (got.kind) {
			case 'aborted':
				this.log({ ...entry, outcome: 'stopped by a person' });
				await this.throwAway(before, ticket.id, STOPPED);
				return { kind: 'aborted' };
			case 'paused':
				await this.throwAway(before, ticket.id, `paused: ${got.why}`);
				this.log({ ...entry, outcome: `paused: ${got.why}` });
				return { kind: 'paused', why: got.why };
			case 'failed':
				this.log({ ...entry, outcome: `failed: ${got.why}`, failure: got.failure });
				if (got.failure === 'lasting') this.lastFailure = got.why;
				await this.handBack(
					ticket,
					before,
					`Nightjar could not build this Ticket: ${got.why}.\n\nFailure: ${got.failure}.\n\nSession: \`claude --resume ${sessionId}\``,
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
				return this.checkAndCommit(
					ticket,
					before,
					sessionId,
					got.summary,
					got.costUsd + earlierUsd,
					got.test
				);
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
		cost: number,
		test?: string
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
			of: { kind: 'build', ...this.output }
		});
		const { check } = fixed;
		const summary = [built, ...fixed.summaries].join('\n\n');
		if (fixed.halt !== undefined) {
			await this.throwAway(before, ticket.id, haltWhy(fixed.halt));
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
		this.note({
			kind: 'ticketBuilt',
			commit: await this.tree.head(),
			ticket: ticket.id,
			session: sessionId
		});
		this.built.add(ticket.id);
		if (test !== undefined) this.tests.set(ticket.id, test);
		if (this.shown?.kind === 'building') {
			// no round of its own any more, so it is not counted as another fix round
			const { retry: _retry, ...shown } = this.shown;
			this.deps.status.doing({
				...shown,
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
				building: (ticket, session, rounds, attempt) =>
					this.building(ticket, 'fix', session, rounds, attempt),
				log: (entry, work) => this.log(entry, work),
				note: this.note
			},
			o
		);
	}

	private building(
		ticket: ItemId | null,
		step: 'build' | 'fix' | 'step' | 'feedback' | 'reviewRound',
		session: string,
		rounds: { readonly round: number | null; readonly rounds: number | null },
		attempt = 1
	) {
		this.sessionStartedAt = this.deps.now();
		this.shown = this.show({
			ticket,
			step,
			...rounds,
			...(attempt > 1 ? { retry: { attempt, of: TRIES } } : {}),
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
		await this.signals.off('working');
		if (this.aborted || last.kind === 'aborted') return this.stopped();
		if (paused) await this.pause(paused);
		const repeated =
			last.kind === 'repeated'
				? `Nightjar stopped building this Feature: ${String(last.tickets.length)} Tickets in a row failed with the same reason, ${last.tickets.map(hash).join(', ')}.\n\nReason: ${last.why}.\n\n`
				: '';
		if ((await this.tree.ahead()) === 0) {
			if (paused) return { kind: 'paused', why: paused };
			const next = featureAfterRunStep(this.setup.signals, {
				waiting: left.length > 0,
				red: false
			});
			const why =
				last.kind === 'repeated' ? `Tickets keep failing: ${last.why}` : 'it built nothing';
			this.deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why, next });
			this.note({ kind: 'handed', to: 'needsInfo', why });
			await this.signals.on('needsInfo');
			await tracker.comment(
				id,
				withNext(
					`${repeated}Nightjar built nothing for this Feature.\n\n${waitingList(left)}`,
					next
				)
			);
			return { kind: 'nothing', waiting: left };
		}

		const red =
			last.kind === 'red' ? { ticket: [...this.built].at(-1) ?? '', tail: last.tail } : null;
		const done = [...this.built].flatMap((n) => this.tickets.filter((t) => t.id === n));
		let review: Review | 'off' | null = 'off';
		let open: ReviewLeftOpen | null = null;
		let declined: readonly Declined[] = [];
		let reviewSessions: readonly ReviewSession[] | 'off' = 'off';
		if (this.setup.review?.enabled !== false) {
			const got = await this.review(done);
			if (got !== null && 'paused' in got) {
				// the pull request's Paused section says why, so it gets no Review section
				if (paused === null) {
					paused = got.paused;
					await this.pause(paused);
				}
			} else if (left.length === 0 && red === null && paused === null) {
				const rounds = await this.reviewRounds(got, done);
				review = rounds.review;
				open = rounds.open;
				declined = rounds.declined;
				reviewSessions = rounds.sessions;
				// a round a person stopped ends the run as any Session they stop does
				if (rounds.stopped) return this.stopped();
				if (rounds.paused !== null) {
					paused = rounds.paused;
					await this.pause(paused);
				}
			} else {
				review = got;
				reviewSessions = [{ kind: 'review', review: got }];
			}
		}
		const pushed = await pushBranch(this.deps, this.setup, this.tree, id);
		if (pushed.kind === 'diverged') {
			// a pause put the Go back, and the Feature is now with a person
			await tracker.removeSignal(id, 'go');
			return { kind: 'diverged', side: pushed.side };
		}
		const complete = left.length === 0 && red === null && paused === null;
		const ids = done.map((t) => t.id);
		const workflow = this.steps?.section(ids, (n) => tracker.reference(n).text) ?? null;
		// every round the branch had, from the ledger, so a run without one still shows the earlier ones
		const rounds = feedbackRounds(this.deps.spend.entries(), this.setup.repo, this.tree.at.branch);
		const body = pullBody({
			tracker,
			feature: this.feature,
			check: this.setup.check,
			complete,
			done,
			left,
			red,
			reviewSessions,
			declined,
			spent: this.costs.reduce((n, c) => n + c.usd, 0),
			costs: this.costs,
			titleOf: (id) => this.tickets.find((t) => t.id === id)?.title,
			paused,
			workflow,
			feedback: rounds.rounds === 0 ? null : feedbackSection(rounds, this.unanswered),
			note: this.workflow?.workflow.output === 'note' ? this.workflow.name : null,
			tests: done.flatMap((t) => {
				const test = this.tests.get(t.id);
				return test === undefined ? [] : [{ ticket: t.id, test }];
			})
		});
		const pull = await this.openDraft(body);
		await noteConflicts(this.deps, this.setup, pull, body);
		// a lone issue is its own Ticket, so it is named once
		const linked = [...new Set([...(complete ? [id] : []), ...done.map((t) => t.id)])];
		await codeHost.placeReferences(
			pull,
			linked.map((n) => tracker.reference(n))
		);
		await this.replyToFeedback(pull);
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
		if (!paused && (left.length > 0 || red || repeated !== '')) {
			const waits = `${String(left.length)} Ticket${left.length === 1 ? '' : 's'} wait`;
			const next = featureAfterRunStep(this.setup.signals, {
				waiting: left.length > 0,
				red: red !== null
			});
			const why = red
				? `the check fails after ${hash(red.ticket)}`
				: last.kind === 'repeated'
					? `Tickets keep failing: ${last.why}`
					: waits;
			this.deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why, next });
			this.note({ kind: 'handed', to: 'needsInfo', why });
			await this.signals.on('needsInfo');
			const failing = red ? `The check fails after ${hash(red.ticket)}.\n\n` : '';
			await tracker.comment(
				id,
				withNext(
					`Nightjar opened ${pull.url}, and this Feature still needs a person.\n\n${repeated}${failing}${waitingList(left)}`,
					next
				)
			);
		} else if (open !== null && review !== null && review !== 'off') {
			await this.handReview(pull, open, review);
		} else if (complete && this.workflow?.workflow.output === 'note') {
			await this.handNote(pull);
		}
		return {
			kind: 'pull',
			pull,
			built: [...this.built],
			waiting: left,
			...(paused === null ? {} : { paused })
		};
	}

	private async stopped(): Promise<FeatureOutcome> {
		await this.deps.tracker.comment(
			this.feature.id,
			withNext('The Nightjar run was stopped by a person.', stoppedStep(this.setup.signals))
		);
		return { kind: 'stopped' };
	}

	private review(done: readonly Ticket[], declined: readonly Declined[] = []) {
		return reviewFeature(
			this.deps,
			this.setup,
			this.tree,
			this.feature,
			done,
			declined,
			progress(this.tickets, this.built, null),
			this.show,
			(e) => this.log(e),
			this.note
		);
	}

	// On a complete Feature, while the Review says changes: a Review round, then the Review again, up to review.fixRounds in the build. A round that fails ends them, the Review before it the last; one a person stops ends the run. `open` says why a person must look: a round that failed, or rounds that ran out on changes.
	private async reviewRounds(
		first: Review | null,
		done: readonly Ticket[]
	): Promise<{
		readonly review: Review | null;
		readonly sessions: readonly ReviewSession[];
		readonly paused: string | null;
		// a person stopped a round, whose work is thrown away
		readonly stopped: boolean;
		readonly open: ReviewLeftOpen | null;
		// the issues the rounds declined, in the order they did
		readonly declined: readonly Declined[];
	}> {
		const { deps } = this;
		const rounds = this.setup.review?.fixRounds ?? DEFAULT_REVIEW_FIX_ROUNDS;
		let declined: readonly Declined[] = [];
		let review = first;
		let ran = 0;
		const sessions: ReviewSession[] = [{ kind: 'review', review }];
		for (let round = 1; round <= rounds && review?.verdict === 'changes'; round += 1) {
			if (this.aborted)
				return { review, sessions, paused: null, stopped: true, open: null, declined };
			const before = this.costs.length;
			const end = await reviewRound({
				codingAgent: deps.codingAgent,
				runCheck: deps.runCheck,
				newId: deps.newId,
				say: deps.say,
				setup: this.setup,
				feature: this.feature,
				tree: this.tree,
				round,
				issues: review.issues,
				declined,
				...this.output,
				dailyPause: () => this.dailyPause(),
				allowance: (cap, spent) => deps.spend.allowance(cap, spent),
				fix: (work) => this.fixReviewRound(work, { round, rounds }),
				log: (entry) => this.log(entry),
				building: (session) => this.building(null, 'reviewRound', session, { round, rounds })
			});
			if (end.kind === 'paused') {
				return { review, sessions, paused: end.why, stopped: false, open: null, declined };
			}
			if (end.kind === 'aborted') {
				return { review, sessions, paused: null, stopped: true, open: null, declined };
			}
			// what the round and its fix rounds cost
			const usd = this.costs
				.slice(before)
				.filter((c) => c.work === 'reviewRound')
				.reduce((n, c) => n + c.usd, 0);
			sessions.push(
				end.kind === 'fixed'
					? { kind: 'round', round, outcome: 'fixed', text: end.summary, usd }
					: { kind: 'round', round, outcome: 'thrown away', text: end.why, usd }
			);
			if (end.kind === 'failed') {
				return {
					review,
					sessions,
					paused: null,
					stopped: false,
					open: { kind: 'failed', round, why: end.why, side: end.side },
					declined
				};
			}
			ran = round;
			declined = [...declined, ...end.declined];
			const again = await this.review(done, declined);
			if (again !== null && 'paused' in again) {
				return { review, sessions, paused: again.paused, stopped: false, open: null, declined };
			}
			review = again;
			sessions.push({ kind: 'review', review });
		}
		const open: ReviewLeftOpen | null =
			ran > 0 && review?.verdict === 'changes' ? { kind: 'exhausted', rounds: ran } : null;
		return { review, sessions, paused: null, stopped: false, open, declined };
	}

	// A Review round's fix rounds show as the round they belong to, its round of the build's, and are logged as it.
	private fixReviewRound(
		o: FixWork,
		rounds: { readonly round: number; readonly rounds: number }
	): Promise<FixEnd> {
		return fixUntilGreen(
			{
				deps: this.deps,
				setup: this.setup,
				tree: this.tree,
				building: (ticket, session, _fix, attempt) =>
					this.building(ticket, 'reviewRound', session, rounds, attempt),
				log: (entry) => this.log({ ...entry, step: 'reviewRound' }),
				note: this.note
			},
			o
		);
	}

	// The Feature is a person's now: the Review still asks for changes, and Nightjar's Review rounds could not, or did not get to, answer them.
	private async handReview(pull: Pull, open: ReviewLeftOpen, review: Review): Promise<void> {
		const id = this.feature.id;
		const next = reviewStep(this.setup.signals);
		const why =
			open.kind === 'failed'
				? `its Review round ${String(open.round)} was thrown away: ${open.why}`
				: 'its Review still asks for changes';
		this.deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why, next });
		this.note({ kind: 'handed', to: 'human', why });
		await this.signals.on('human');
		await this.deps.tracker.comment(id, withNext(reviewOpenComment(pull.url, open, review), next));
	}

	// A note is findings for a person, never a change to merge unread: the Feature is handed to them to read it.
	private async handNote(pull: Pull): Promise<void> {
		const id = this.feature.id;
		const next = noteStep(pull.url);
		const why = 'its note is for a person to read';
		this.deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why, next });
		this.note({ kind: 'handed', to: 'human', why });
		await this.signals.on('human');
		await this.deps.tracker.comment(
			id,
			withNext(
				`Nightjar wrote a note for this Feature, under \`${NOTES_FOLDER}/\` in ${pull.url}. It holds findings, not code, so it waits for a person to read it.`,
				next
			)
		);
	}

	// The Go back, so a later run goes on from the branch.
	private async pause(why: string): Promise<void> {
		this.note({ kind: 'paused', why });
		await this.signals.on('go');
		this.deps.say(`paused: ${why}`);
		this.deps.status.doing({ kind: 'paused', why, until: null });
	}

	// The branch's open pull request with a new body, else a new draft.
	// Whether Nightjar published the open pull request a rebuild rewrites, which its body's mark says; a Code host that cannot list its open pull requests has none to tell.
	private async publishedBefore(open: Pull): Promise<boolean> {
		const pulls = await this.deps.codeHost.openPulls?.(this.tree.at.branch);
		const body = pulls?.find((p) => p.pull.id === open.id)?.body ?? '';
		return publishedByNightjar(body);
	}

	private async openDraft(body: string): Promise<Pull> {
		const { codeHost } = this.deps;
		const open = await codeHost.openPull(this.tree.at.branch);
		if (open) {
			await codeHost.editBody(
				open,
				(await this.publishedBefore(open)) ? markPublished(body) : body
			);
			this.note({ kind: 'pullOpened', url: open.url, created: false });
			return open;
		}
		const made = await codeHost.createDraft({
			title: this.feature.title,
			head: this.tree.at.branch,
			base: this.setup.baseBranch,
			body
		});
		this.note({ kind: 'pullOpened', url: made.url, created: true });
		await this.pointBotAt(made);
		return made;
	}

	// The bot's pull request a botPulls Source made the Feature for gets one comment, when the draft opens, linking it; Nightjar never pushes to it or closes it.
	private async pointBotAt(made: Pull): Promise<void> {
		const bot = botPullOf(this.feature.body);
		if (bot === null) return;
		const text = withFooter(
			`Nightjar opened ${made.url} with a fix for the red checks here. It holds this pull request's commits too. Merge it, then close this one.`
		);
		try {
			await this.deps.codeHost.comment(bot, text);
		} catch (fault) {
			this.deps.say(`could not comment on ${bot.url}: ${why(fault)}`);
		}
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
		rounds: { readonly round: number; readonly rounds: number },
		attempt?: number
	) => void;
	readonly log: (entry: LogEntry, work: Work) => void;
	// writes the Feature's Logbook
	readonly note: Note;
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
		ctx.note({
			kind: 'checkRed',
			report: check.tail,
			round,
			rounds: limits.fixRounds,
			...(o.ticket === null ? {} : { ticket: o.ticket }),
			session: o.sessionId
		});
		// a try that fails for a passing reason starts again from what the build and the rounds before left
		const mark = await tree.snapshot();
		const { outcome: got, earlierUsd } = await retryPassing<FixOutcome>({
			budgetUsd: budget,
			enough: (usd) => deps.spend.allowance(usd, 0).enough,
			reset: () => tree.restore(mark),
			sleep: deps.sleep,
			signal: setup.signal,
			run: (usd, attempt) => {
				ctx.building(o.ticket, o.sessionId, { round, rounds: limits.fixRounds }, attempt);
				return deps.codingAgent.fix({
					kind: 'fix',
					at: tree.at,
					of: o.of,
					resume: o.sessionId,
					round,
					tail: check.tail,
					budgetUsd: usd,
					...(minutes === undefined ? {} : { minutes })
				});
			},
			record: (failed) =>
				ctx.log(
					{
						ticket: o.ticket,
						step: 'fix',
						session: o.sessionId,
						costUsd: failed.costUsd,
						outcome: `failed: ${failed.why}`,
						failure: 'passing'
					},
					work
				),
			retrying: (attempt, why) =>
				deps.say(
					`${o.name}: ${why}; retrying after a passing fault, try ${String(attempt)} of ${String(TRIES)}`
				)
		});
		spent += got.costUsd + earlierUsd;
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
				outcome: `round ${String(round)}${gaveUp ? ' gave up' : ''}`,
				...(got.kind === 'failed' ? { failure: got.failure } : {})
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
	// a green fix whose push was rejected because a person pushed to the branch: it is kept on `side`, and the Feature is handed to a person
	| {
			readonly kind: 'diverged';
			readonly pull: Pull;
			readonly round: number;
			readonly side: string;
			readonly usd: number;
	  }
	// the pull request is not Nightjar's to fix after all; nothing was done
	| { readonly kind: 'skipped'; readonly why: string }
	| { readonly kind: 'paused'; readonly why: string }
	| { readonly kind: 'stopped' };

// How a Pull-check fix round that ran ended: the outcomes that are not about a round that never began.
type PullFixRound = Exclude<PullFixOutcome, { readonly kind: 'atLimit' | 'skipped' }>;

// One Pull-check fix round on a red draft pull request: a Session that resumes the head commit's, or a new one where this machine lacks it, the repo's check with the usual fix rounds, and a new commit pushed only when it is green. No review and no Step runs after it.
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
	const note = noteFor(deps.logbook, feature.id, deps.now);
	const signals = signalsOf(tracker, feature.id, note);
	const base = baseOf(feature.body);
	const tree = await deps.openWorktree(
		setup.root,
		setup.worktrees,
		draft.branch,
		base !== null && 'branch' in base ? base.branch : setup.baseBranch,
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
	const headSession = trailers.get(SESSION_TRAILER);
	// counted from the branch, so neither a new run nor taking needs a person off resets it
	const used = await tree.pullFixes();
	const rounds = setup.limits.pullFixRounds;
	if (used >= rounds) {
		const why = `it has had its ${String(rounds)} Pull-check fix round${rounds === 1 ? '' : 's'}`;
		deps.say(`${hash(feature.id)}: the Pull checks of ${pull.url} fail, and ${why}`);
		await handOver(deps, setup, { feature: feature.id, note, signals }, draft, why, draft.body);
		return { kind: 'atLimit', pull, rounds };
	}
	const round = used + 1;
	deps.say(`${hash(feature.id)}: the Pull checks of ${pull.url} fail, fix ${String(round)}`);
	// the head commit's Session where this machine still has it, else a new one
	const session: PullFixSession =
		headSession !== undefined && deps.sessionExists(headSession)
			? { kind: 'resume', id: headSession }
			: { kind: 'fresh', id: deps.newId() };
	if (session.kind === 'fresh') {
		deps.say(
			`${hash(feature.id)}: ${headSession === undefined ? 'the head commit names no Session' : `Session ${headSession} is not on this machine`}, starting a new one`
		);
	}
	await signals.on('working');
	let got: PullFixRound;
	try {
		got = await pullFixRound(deps, setup, { feature, tree, draft, session, round });
		note({
			kind: 'pullFix',
			round,
			rounds: setup.limits.pullFixRounds,
			failing: draft.checks.failed.map((f) => ({ check: f.check, job: f.job, step: f.step })),
			end: pullFixEnd(got),
			...(got.kind === 'gaveUp' || got.kind === 'paused' ? { why: got.why } : {}),
			...(got.kind === 'diverged'
				? { why: `a person pushed to the branch first; the fix is kept on ${got.side}` }
				: {}),
			session: session.id
		});
		// every round that ran says so in the body, the one that gave up too
		const ran = (r: Pick<PullRound, 'outcome' | 'summary' | 'usd'>) =>
			withPullRound(draft.body, { round, failed: draft.checks.failed, ...r });
		if (got.kind === 'fixed') {
			const body = ran({ outcome: 'pushed', summary: got.summary, usd: got.usd });
			await deps.codeHost.editBody(pull, body);
			await noteConflicts(deps, setup, pull, body);
		} else if (got.kind === 'gaveUp') {
			const why = `Pull-check fix ${String(round)} gave up: ${got.why}`;
			const body = ran({ outcome: 'gave up', summary: `It gave up: ${got.why}.`, usd: got.usd });
			await handOver(deps, setup, { feature: feature.id, note, signals }, draft, why, body);
		}
	} finally {
		await signals.off('working');
	}
	return got;
}

// How a Pull-check fix round that ran ended, as its Logbook entry says.
function pullFixEnd(got: PullFixRound) {
	switch (got.kind) {
		case 'fixed':
			return 'pushed';
		case 'gaveUp':
			return 'gaveUp';
		case 'paused':
			return 'paused';
		case 'stopped':
			return 'stopped';
		case 'diverged':
			return 'diverged';
	}
}

// Says in the pull request body whether it conflicts with the base branch: the section is added when it does and dropped when it does not. Nothing else happens, no Signal and no comment.
async function noteConflicts(deps: Deps, setup: Setup, pull: Pull, body: string): Promise<void> {
	const { codeHost } = deps;
	let conflicting: boolean;
	try {
		conflicting = await conflicts(codeHost, pull, deps.sleep, setup.signal);
	} catch (fault) {
		// the note is advice for a reviewer, so a read that fails leaves the body as it is and never stops the build
		deps.say(
			`could not read whether ${pull.url} conflicts with ${setup.baseBranch}: ${why(fault)}`
		);
		return;
	}
	const wanted = conflicting ? withConflicts(body, setup.baseBranch) : withoutConflicts(body);
	if (wanted !== body) await codeHost.editBody(pull, wanted);
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
	of: { readonly feature: ItemId; readonly note: Note; readonly signals: FeatureSignals },
	draft: NightjarDraft,
	why: string,
	// the pull request body as it is to stay, before the mark
	body: string
): Promise<void> {
	const { feature, note, signals } = of;
	const { pull } = draft;
	note({ kind: 'handed', to: 'human', why });
	await signals.on('human');
	const failing = draft.checks.failed.map(failingLine);
	const comment = `Nightjar could not make the Pull checks of ${pull.url} green: ${why}.\n\nFailing Pull checks:\n\n${failing.join('\n')}`;
	await deps.tracker.comment(feature, withNext(comment, pullChecksStep(setup.signals)));
	await deps.codeHost.editBody(pull, markHandedOver(body));
	deps.say(`${hash(feature)}: handed to a person, ${why}`);
}

// The Session a Pull-check fix round runs in: the head commit's, resumed, or a new one when this machine has none.
type PullFixSession = { readonly kind: 'resume' | 'fresh'; readonly id: string };

async function pullFixRound(
	deps: Deps,
	setup: Setup,
	o: {
		feature: Feature;
		tree: Worktree;
		draft: NightjarDraft;
		session: PullFixSession;
		round: number;
	}
): Promise<PullFixRound> {
	const { feature, tree, draft, round } = o;
	const session = o.session.id;
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
	const gaveUp = async (why: string, usd: number): Promise<PullFixRound> => {
		const side = await tree.discard(before, `pull-fix-${String(round)}`);
		deps.say(
			`${hash(feature.id)}: ${name} gave up: ${why}${side ? `; the attempt is kept on ${side}` : ''}`
		);
		return { kind: 'gaveUp', pull, round, why, usd };
	};
	const halted = async (halt: Halt): Promise<PullFixRound> => {
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
	// a new Session knows nothing of the work: it is given the Feature and the branch's diff as it stands
	const fresh =
		o.session.kind === 'fresh' ? { feature, diff: await tree.diff(DIFF_CHARS) } : undefined;
	const got = await deps.codingAgent.fix({
		kind: 'fix',
		at: tree.at,
		of: fresh === undefined ? { kind: 'pullChecks' } : { kind: 'pullChecks', fresh },
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
			log({
				...entry,
				outcome: `pull checks ${String(round)} failed: ${got.why}`,
				failure: got.failure
			});
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
			log: (e) => log(e),
			note: noteFor(deps.logbook, feature.id, deps.now)
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
	const pushed = await pushBranch(deps, setup, tree, feature.id);
	if (pushed.kind === 'diverged') {
		return { kind: 'diverged', pull, round, side: pushed.side, usd: fixed.spent };
	}
	deps.say(`${hash(feature.id)}: ${name} pushed to ${pull.url}`);
	return { kind: 'fixed', pull, round, summary, usd: fixed.spent };
}

// How a push of a Feature's branch ended: on the Code host, or set aside on `side` because a person pushed to the branch first.
export type PushEnd =
	{ readonly kind: 'pushed' } | { readonly kind: 'diverged'; readonly side: string };

// Every push of a Feature's branch. One that fails is sorted by git, never by what the push said (ADR 0010): a branch a person pushed to hands the Feature to them, and any other failure is thrown.
async function pushBranch(
	deps: Deps,
	setup: Setup,
	tree: Worktree,
	feature: ItemId
): Promise<PushEnd> {
	const { branch } = tree.at;
	try {
		await deps.codeHost.push(tree.at.folder, branch);
		return { kind: 'pushed' };
	} catch (fault) {
		const outcome = await tree.pushOutcome();
		if (outcome === 'fault') throw fault;
		if (outcome === 'pushed') {
			deps.say(
				`${hash(feature)}: the push of ${branch} failed, yet the Code host holds it: ${why(fault)}`
			);
			return { kind: 'pushed' };
		}
		const side = await tree.setAsidePush();
		await deps.tracker.addSignal(feature, 'human');
		await deps.tracker.comment(feature, branchMovedComment(setup.signals, branch, side));
		deps.say(
			`${hash(feature)}: handed to a person, ${branch} moved on the Code host; the work is kept on ${side}`
		);
		return { kind: 'diverged', side };
	}
}

async function reviewFeature(
	deps: Deps,
	setup: Setup,
	tree: Worktree,
	feature: Feature,
	built: readonly Ticket[],
	declined: readonly Declined[],
	tickets: TicketProgress[],
	show: ShowBuilding,
	log: (entry: LogEntry) => void,
	note: Note
): Promise<Review | null | { readonly paused: string }> {
	const before = await tree.head();
	const { outcome: got } = await retryPassing<ReviewOutcome>({
		budgetUsd: setup.limits.reviewUsd,
		enough: (usd) => deps.spend.allowance(usd, 0).enough,
		reset: () => tree.revert(before),
		sleep: deps.sleep,
		signal: setup.signal,
		run: (budgetUsd, attempt) => {
			const sessionId = deps.newId();
			deps.say(`${hash(feature.id)}: review, session ${sessionId}`);
			deps.status.doing(
				show({
					ticket: null,
					step: 'review',
					round: null,
					rounds: null,
					...(attempt > 1 ? { retry: { attempt, of: TRIES } } : {}),
					session: sessionId,
					tickets
				})
			);
			return deps.codingAgent.review({
				kind: 'review',
				at: tree.at,
				sessionId,
				feature,
				tickets: built,
				declined,
				budgetUsd
			});
		},
		record: (failed) =>
			log({
				ticket: null,
				step: 'review',
				session: failed.sessionId,
				costUsd: failed.costUsd,
				outcome: `failed: ${failed.why}`,
				failure: 'passing'
			}),
		retrying: (attempt, why) =>
			deps.say(
				`${hash(feature.id)}: ${why}; retrying after a passing fault, try ${String(attempt)} of ${String(TRIES)}`
			)
	});
	const entry = {
		ticket: null,
		step: 'review' as const,
		session: got.sessionId,
		costUsd: got.costUsd
	};
	const unfinished = () =>
		note({
			kind: 'review',
			verdict: null,
			summary: null,
			issues: [],
			session: got.sessionId
		});
	switch (got.kind) {
		case 'paused':
			log({ ...entry, outcome: `paused: ${got.why}` });
			return { paused: got.why };
		case 'reviewed': {
			log({ ...entry, outcome: got.review.verdict });
			const { verdict, summary, issues } = got.review;
			note({
				kind: 'review',
				verdict,
				summary,
				issues: issues.map((i) => ({ ...i })),
				session: got.sessionId
			});
			return got.review;
		}
		// a stopped review is one that did not finish: the run is past its last Ticket
		case 'aborted':
			log({ ...entry, outcome: 'failed: stopped by a person' });
			unfinished();
			return null;
		case 'failed':
			log({ ...entry, outcome: `failed: ${got.why}`, failure: got.failure });
			unfinished();
			return null;
	}
}

const BLOCKED_FROM_OUTSIDE =
	", a Ticket outside this Feature: it closes when its Feature's pull request merges. Merge that, then give the Go again.";

// `name` is how the place the list goes names a Ticket: #N on the Tracker, its reference on the Code host.
function waitingList(left: readonly Waiting[], name: (id: ItemId) => string = hash): string {
	if (left.length === 0) return 'No Ticket is waiting.';
	const line = (w: Waiting) =>
		`- ${name(w.id)} ${w.title}: ${w.why}${w.blocker === undefined ? '' : ` ${name(w.blocker)}`}${w.outside ? BLOCKED_FROM_OUTSIDE : ''}`;
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
	// the Reviews and Review rounds of the build in order, or 'off' when the Review is switched off or paused
	reviewSessions: readonly ReviewSession[] | 'off';
	// the issues the Review rounds declined, with their reasons
	declined: readonly Declined[];
	spent: number;
	costs: readonly Cost[];
	titleOf: (id: ItemId) => string | undefined;
	paused: string | null;
	// the Workflow's section, when it ran or left a Step
	workflow: string | null;
	// the Feedback section, once the branch has had a Feedback round
	feedback: string | null;
	// the tests the Sessions said show a bug, by Ticket
	tests: readonly { ticket: ItemId; test: string }[];
	// the name of the Workflow, when its output is a note rather than code
	note: string | null;
}): string {
	const ref = (id: ItemId) => p.tracker.reference(id).text;
	const parts = [
		`Nightjar built ${p.complete ? 'all of' : 'part of'} ${ref(p.feature.id)} ${p.feature.title}.`,
		`## Built\n\n${p.done.map((t) => `- ${ref(t.id)} ${t.title}`).join('\n')}`
	];
	if (p.note !== null) {
		parts.push(
			`## A note, not code\n\nThe Workflow \`${p.note}\` writes findings, not code: this pull request holds a note under \`${NOTES_FOLDER}/\`. Read it, then close the Feature or follow up on what it recommends. It is not meant to be merged unread.`
		);
	}
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
	if (p.tests.length > 0) {
		const many = p.tests.length > 1;
		const lines = p.tests.map((t) => `- ${ref(t.ticket)}: ${t.test}`).join('\n');
		parts.push(`## ${many ? 'Tests that show the bugs' : 'Test that shows the bug'}\n\n${lines}`);
	}
	if (p.workflow !== null) parts.push(p.workflow);
	if (p.feedback !== null) parts.push(p.feedback);
	if (p.reviewSessions !== 'off') parts.push(reviewSection(p.reviewSessions, p.declined));
	parts.push(costSection(p.spent, p.costs, ref, p.titleOf));
	parts.push(featureMarker(p.feature.id));
	// the last Review of the build, whatever a round did after it
	const last =
		p.reviewSessions === 'off' ? undefined : p.reviewSessions.findLast((r) => r.kind === 'review');
	const approved = last?.kind === 'review' && last.review?.verdict === 'approve';
	parts.push(publishMark({ complete: p.complete, approved }));
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

// The total, then what each Ticket cost by kind of work, the Steps after all Tickets, the Feedback round, the review and its rounds; a kind with no Session is left out.
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
	if (has(null, 'feedback')) lines.push(`- Feedback round: ${dollars(sum(null, 'feedback'))}`);
	if (has(null, 'review')) lines.push(`- Review: ${dollars(sum(null, 'review'))}`);
	if (has(null, 'reviewRound')) lines.push(`- Review rounds: ${dollars(sum(null, 'reviewRound'))}`);
	const head = `## Cost\n\nEstimated cost of this run: ${dollars(spent)}.`;
	return lines.length === 0 ? head : `${head}\n\n${lines.join('\n')}`;
}

const issueLines = (issues: Review['issues']) => issues.map(issueLine).join('\n');

// Why the Feature needs a person after its Review rounds: one failed and was thrown away, or the rounds ran out with the Review still saying changes.
type ReviewLeftOpen =
	| {
			readonly kind: 'failed';
			readonly round: number;
			readonly why: string;
			// the branch the thrown-away attempt is kept on, when it left anything
			readonly side: string | null;
	  }
	| { readonly kind: 'exhausted'; readonly rounds: number };

// What the last Review left open, as the comment on the Feature says it.
function reviewOpenComment(url: string, open: ReviewLeftOpen, review: Review): string {
	const cause =
		open.kind === 'failed'
			? `Review round ${String(open.round)} was thrown away: ${open.why}.${open.side === null ? '' : ` Its work is kept on the branch \`${open.side}\`.`} The branch keeps the commits before it, and no more Review rounds ran.\n\nThe last Review said changes`
			: `Nightjar ran ${String(open.rounds)} Review round${open.rounds === 1 ? '' : 's'}, and the last Review still says changes`;
	const issues = issueLines(review.issues);
	return `Nightjar opened ${url}, and this Feature still needs a person.\n\n${cause}: ${review.summary}${issues ? `\n\n${issues}` : ''}`;
}

// What a Feature is told when a push of its branch is rejected because a person pushed to it, whatever the push followed.
export function branchMovedComment(n: SignalNames, branch: string, side: string): string {
	return withNext(
		`Nightjar could not push to \`${branch}\`: the branch moved on the Code host while Nightjar worked, so a person has pushed to it. Nightjar set its own work aside on the local branch \`${side}\`, put \`${branch}\` back at the Code host's head, and will not push to this draft pull request again on its own.`,
		pushRejectedStep(n, side)
	);
}

function reviewComment(review: Review): string {
	const issues = issueLines(review.issues);
	return `**Nightjar review: ${review.verdict === 'approve' ? 'approve' : 'changes'}**\n\n${review.summary}${issues ? `\n\n${issues}` : ''}${FOOTER}`;
}
