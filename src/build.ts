// The build loop: one Feature from the Go to a draft pull request, through the Tracker and Code host seams alone.
import type { RunCheck } from './check.js';
import type { CodeHost, NightjarDraft, Pull } from './code-host.js';
import {
	envOf,
	resetOf,
	type BuildOutcome,
	type CodingAgent,
	type FixOutcome,
	type ReviewOutcome
} from './coding-agent.js';
import { DEFAULT_PULL_CHECKS, DEFAULT_REVIEW_FIX_ROUNDS } from './config.js';
import {
	BuildFault,
	passingFault,
	placeText,
	stackOf,
	type FaultPlace,
	type FaultRun
} from './fault.js';
import { pullChecksReport } from './gate.js';
import {
	feedbackRound,
	feedbackRounds,
	feedbackSection,
	replyText,
	thrownAwayAsk,
	type FeedbackRoundEnd,
	type Unanswered
} from './feedback-round.js';
import { FOOTER, withFooter } from './footer.js';
import { baseOf, botPullOf } from './base-line.js';
import type { Env } from './git.js';
import { noteFor, type Logbook, type Note } from './logbook.js';
import { DEFAULT_DAILY_USD } from './person-config.js';
import { buildOrder, nextTicket, progress, waiting, type Waiting } from './plan.js';
import { conflicts, withConflicts, withoutConflicts } from './conflicts-section.js';
import { why } from './say.js';
import { failingLine, withPullRound, type PullRound } from './pull-checks-section.js';
import {
	QUESTIONS_MARK,
	issueLine,
	questionList,
	questionRounds,
	type Declined,
	type Question,
	type Review
} from './prompt.js';
import type { Serve } from './serve.js';
import type { Failure } from './session.js';
import { NOTES_FOLDER } from './settings.js';
import {
	draftStep,
	featureAfterRunStep,
	featureStopStep,
	feedbackStep,
	nextStepText,
	noteStep,
	pausedStep,
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
import { byModel } from './build-cost.js';
import {
	modelsOf,
	type Allowance,
	type Entry,
	type LogEntry,
	type ModelUsage,
	type Spend
} from './spend.js';
import type { Doing, StatusReport, TicketProgress } from './status.js';
import { dollars, tokensText } from './view-text.js';
import {
	buildingSentence,
	headline,
	NOT_BUILT,
	readStatusNote,
	statusNoteText,
	waitingCommentText,
	withHeadline,
	type NoteTicket,
	type StatusNote,
	type WaitingComment
} from './status-note.js';
import {
	isStatusNote,
	statusNoteOf,
	type Comment,
	type Feature,
	type ItemId,
	type Ticket,
	type Tracker
} from './tracker.js';
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
	type StepRound,
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
	// how long the run waits after a pause before it tries the Feature again, which the Status note gives as the time it is paused until; left out where nothing tries it again on its own, as under --once
	readonly pauseMs?: number;
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
			// a Session ended on a reason of the machine or the plan after the pull request was opened: the Feature has the Go back, and the run pauses
			readonly pause?: Pause;
	  }
	| { readonly kind: 'nothing'; readonly waiting: Waiting[] }
	// the run stopped for a reason of the machine or the plan, not of the Feature; it goes on later
	| ({ readonly kind: 'paused' } & Pause)
	| { readonly kind: 'stopped' }
	// a person pushed to the branch first: the work waits on the local branch `side`, and the Feature is theirs
	| { readonly kind: 'diverged'; readonly side: string };

// Why the run pauses, and when it may go on: `resetsAt` (epoch seconds) is the plan's usage limit's reset time, when it gave one.
export interface Pause {
	readonly why: string;
	readonly resetsAt?: number;
}

// A comment for a person: what happened, then what they do next.
const withNext = (body: string, step: NextStep) => `${body}\n\n${nextStepText(step)}${FOOTER}`;

// What a piece of work with a `cap` that has spent `spent` may still spend. The day's limit with the other Slots' caps is checked where each Session starts (`heldSession`), which makes the Session wait for room rather than leave the work red.
const allowanceOf =
	(deps: Pick<Deps, 'spend'>) =>
	(cap: number, spent: number): Allowance =>
		deps.spend.allowance(cap, spent);
const hash = (id: ItemId) => `#${id}`;

// The kind of work a Session's cost is split under in the pull request; a Step's fix rounds belong to 'steps', a Feedback round's to 'feedback', a Review round's to 'reviewRound'.
type Work = 'build' | 'fix' | 'steps' | 'review' | 'pullChecks' | 'feedback' | 'reviewRound';

// What this run spent on one kind of work, after one Ticket or, with no Ticket, after all of them.
interface Cost {
	readonly ticket: ItemId | null;
	readonly work: Work;
	readonly usd: number;
	// the Step and its round, for a Step's Session and its fix rounds
	readonly stepRound?: StepRound;
	// the models its Session ran on, when it said
	readonly models?: readonly ModelUsage[];
}

const workOf = (step: Entry['step']): Work => (step === 'step' ? 'steps' : step);

// What building one Ticket left the run to do next.
type Step =
	| { readonly kind: 'next' }
	| Halt
	| { readonly kind: 'red'; readonly tail: string }
	| { readonly kind: 'repeated'; readonly why: string; readonly tickets: readonly ItemId[] };

// What a Session's failure means for the person who reads the hand-back, in plain words.
const failureCause: Record<Failure, string> = {
	passing: 'This kind of fault often goes away by itself, so another try may work.',
	budget: 'The Session used up its budget or its time before it finished.',
	lasting: 'This fault will probably repeat, so fix what the reason names before another try.'
};

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

// What a fault that escapes the build names: where the run is now, and what its Status note lists.
interface Whereabouts {
	now: () => FaultRun;
}

const SETUP: FaultPlace = { kind: 'setup' };

// A fault that escaped the build, written to the Feature's Logbook with its stack trace and thrown again as a BuildFault that names where it happened. `note` is null before the Feature is known.
function faultAt(fault: unknown, run: FaultRun, note: Note | null): BuildFault {
	if (fault instanceof BuildFault) return fault;
	const stack = stackOf(fault);
	try {
		note?.({
			kind: 'fault',
			place: placeText(run.place),
			why: why(fault),
			passing: passingFault(fault),
			...(stack === undefined ? {} : { stack }),
			...(run.session === null ? {} : { session: run.session })
		});
	} catch {
		// the Logbook itself may be the fault
	}
	return new BuildFault(fault, run);
}

// One Feature built. A fault that escapes it is thrown as a BuildFault, which names where in the build it happened.
export async function buildFeature(
	deps: Deps,
	setup: Setup,
	id: ItemId,
	started?: Asked
): Promise<FeatureOutcome> {
	const feature = await deps.tracker.feature(id);
	const note = noteFor(deps.logbook, feature.id, deps.now);
	const where: Whereabouts = {
		now: () => ({ place: SETUP, tickets: [], session: null, pull: null })
	};
	try {
		return await startFeature(deps, setup, feature, note, where, started);
	} catch (fault) {
		throw faultAt(fault, where.now(), note);
	}
}

async function startFeature(
	deps: Deps,
	setup: Setup,
	feature: Feature,
	note: Note,
	where: Whereabouts,
	started?: Asked
): Promise<FeatureOutcome> {
	const { tracker } = deps;
	const { id } = feature;
	const branch = branchFor(feature.id, feature.title);
	deps.say(`${hash(id)} ${feature.title}: building on ${branch}`);
	beginRun(tracker, id);
	// the Feature's start, before anything else reads the clock
	const show = buildingOf(feature, deps.now);
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
			{ feature, note, signals, tickets, built: new Set() },
			why,
			{ text: 'No Ticket was started.' },
			setup.signals
		);
	}
	// a botPulls Source's Feature is built on the bot's branch, so the new versions are in it
	const base = baseOf(feature.body);
	if (base !== null && 'fault' in base) {
		return needsInfoStop(
			deps,
			{ feature, note, signals, tickets, built: new Set() },
			base.fault,
			{ text: 'No Ticket was started.' },
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
	where.now = () => ({
		place: SETUP,
		tickets: noteTickets(feature, tickets, built),
		session: null,
		pull: null
	});
	// the Tickets are planned once the branch says which are built
	deps.status.doing(settingUp(progress(tickets, built, null)));
	await writeStatusNote(deps, feature, {
		state: 'building',
		sentence:
			started === undefined
				? 'Nightjar picked this Feature up and is building it.'
				: 'Nightjar is building this Feature again, for a request for changes on its pull request.',
		tickets: noteTickets(feature, tickets, built),
		pull: null,
		next: null,
		session: null
	});
	if (setup.setupCommand !== undefined && !(await tree.isSetUp())) {
		const command = setup.setupCommand;
		deps.say(`${hash(id)}: setup: ${command}`);
		const got = await deps.runSetup(command, tree.at.folder, envOf(setup));
		note({ kind: 'setup', command, ok: got.ok });
		if (!got.ok) {
			const why = `the setup command \`${command}\` failed`;
			return needsInfoStop(
				deps,
				{ feature, note, signals, tickets, built },
				why,
				{
					text: `Nightjar ran it in the new worktree for this Feature, and no Ticket was started. This is the end of what it printed:`,
					output: got.tail
				},
				setup.signals
			);
		}
		await tree.markSetUp();
	}
	const workflow = chosen.kind === 'workflow' ? chosen : null;
	const run = new FeatureRun(deps, setup, feature, tree, tickets, built, workflow, show, started);
	where.now = () => run.whereabouts();
	return run.build();
}

// A Feature stopped before it built anything, with the reason on it; a later Go builds it again. `cause` says in plain words what the reason means; `output` is what a failed command printed, which the comment quotes the end of, since no pull request holds it yet.
async function needsInfoStop(
	deps: Deps,
	of: {
		readonly feature: Feature;
		readonly note: Note;
		readonly signals: FeatureSignals;
		readonly tickets: readonly Ticket[];
		readonly built: ReadonlySet<ItemId>;
	},
	why: string,
	cause: { readonly text: string; readonly output?: string },
	names: SignalNames
): Promise<FeatureOutcome> {
	const { feature, note, signals, tickets, built } = of;
	const id = feature.id;
	const next = featureStopStep(names);
	deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why, next });
	note({ kind: 'handed', to: 'needsInfo', why });
	await signals.off('working');
	await signals.on('needsInfo');
	await askAPerson(deps, feature, {
		ask: {
			sentence: `Nightjar built nothing: ${why}.`,
			cause: cause.text,
			...(cause.output === undefined ? {} : { output: cause.output }),
			next
		},
		tickets: noteTickets(feature, tickets, built),
		session: null
	});
	return { kind: 'nothing', waiting: waiting(tickets, built) };
}

// What a comment that needs a person says, before it names the Logbook.
type Ask = Omit<WaitingComment, 'logbook'>;

// A comment, and the web address the Tracker gives it, when it gives one.
async function postComment(
	tracker: Tracker,
	to: ItemId,
	body: string
): Promise<string | undefined> {
	const link = await tracker.comment(to, body);
	return typeof link === 'string' ? link : undefined;
}

// The new comment that tells a person they are needed. It is a comment, not an edit, so it notifies them, and it stands on its own: the headline, the cause, the Next step and where the Logbook is. `to` is the Feature or the Ticket it goes on; the Logbook is the Feature's.
async function postAsk(
	tracker: Tracker,
	o: {
		readonly to: ItemId;
		readonly feature: ItemId;
		readonly ask: Ask;
		readonly session: string | null;
	}
): Promise<string | undefined> {
	const logbook = { feature: o.feature, session: o.session };
	return postComment(tracker, o.to, waitingCommentText({ ...o.ask, logbook }));
}

// What a Feature that needs a person is told, and the Tickets and Session its Status note shows.
interface Asking {
	readonly ask: Ask;
	readonly tickets: readonly NoteTicket[];
	readonly session: string | null;
}

// The Status note of a Feature that needs a person: Waiting on you, with the same sentence and Next step as the comment that asked.
function noteWaiting(
	deps: Pick<Deps, 'tracker' | 'say' | 'now'>,
	feature: Pick<Feature, 'id'>,
	o: Asking
): Promise<void> {
	const { ask } = o;
	return writeStatusNote(deps, feature, {
		state: 'waiting',
		sentence: ask.sentence,
		tickets: o.tickets,
		pull: ask.pull === undefined ? null : { url: ask.pull.url },
		next: ask.next.length > 0 ? ask.next : null,
		session: o.session
	});
}

// A Feature that needs a person: a new comment that notifies them, and its Status note saying Waiting on you.
export async function askAPerson(
	deps: Pick<Deps, 'tracker' | 'say' | 'now'>,
	feature: Pick<Feature, 'id'>,
	o: Asking
): Promise<void> {
	const { ask, session } = o;
	await postAsk(deps.tracker, { to: feature.id, feature: feature.id, ask, session });
	await noteWaiting(deps, feature, o);
}

// The Features whose build has begun and whose Status note has not been written since, by Tracker: the next write moves the note's headline under Earlier runs, and the writes after it do not.
const newRuns = new WeakMap<Tracker, Set<ItemId>>();

function beginRun(tracker: Tracker, feature: ItemId): void {
	const begun = newRuns.get(tracker) ?? new Set<ItemId>();
	begun.add(feature);
	newRuns.set(tracker, begun);
}

// The Feature's Status note, on a Tracker that keeps one; a Tracker without `statusNote` gets no word of a quiet update, as before it. A note that cannot be written is said, and the build goes on: it notifies no one, so nothing waits on it.
export async function writeStatusNote(
	deps: Pick<Deps, 'tracker' | 'say' | 'now'>,
	feature: Pick<Feature, 'id'>,
	note: Omit<StatusNote, 'logbook' | 'earlier' | 'at'> & { readonly session: string | null }
): Promise<void> {
	const { tracker } = deps;
	if (tracker.statusNote === undefined) return;
	const { session, ...rest } = note;
	const at = deps.now().toISOString();
	const beginning = newRuns.get(tracker)?.has(feature.id) === true;
	try {
		// the history is the note's own: what it holds now stays, and a new run adds the headline it replaces
		const found = statusNoteOf(await tracker.comments(feature.id), await tracker.me());
		const read = found === undefined ? null : readStatusNote(found.body, at);
		const earlier = [...(read?.earlier ?? [])];
		const current = read?.current ?? null;
		if (beginning && current !== null && current.sentence !== NOT_BUILT) earlier.push(current);
		await tracker.statusNote(
			feature.id,
			statusNoteText({ ...rest, earlier, at, logbook: { feature: feature.id, session } })
		);
		if (beginning) newRuns.get(tracker)?.delete(feature.id);
	} catch (fault) {
		deps.say(`${hash(feature.id)}: could not write its Status note: ${why(fault)}`);
	}
}

// A Lone issue is its own Ticket, so its note lists none. The others are listed in Build order, `current` the one being built.
// `links` are the comments that handed Tickets back, by Ticket; a Ticket still waiting links its comment.
export const noteTickets = (
	feature: Feature,
	tickets: readonly Ticket[],
	built: ReadonlySet<ItemId>,
	current: ItemId | null = null,
	links: ReadonlyMap<ItemId, string> = new Map()
): NoteTicket[] =>
	feature.lone === true
		? []
		: progress(buildOrder(tickets), built, current).map((t) => {
				const handBack = t.state === 'waiting' ? links.get(t.id) : undefined;
				return handBack === undefined ? t : { ...t, handBack };
			});

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
	// the Session the run was last in, which the Status note's Logbook line names
	private session: string | null = null;
	// the comments that handed Tickets back this run, by Ticket, which the Status note's Ticket list links
	private readonly handBackLinks = new Map<ItemId, string>();
	// what a Feedback round that was thrown away asked of a person, whose comment is posted; the Status note at the end of the run says it
	private feedbackAsk: Ask | null = null;
	// where in the build the run is, which a fault that escapes it names
	private place: FaultPlace = SETUP;
	// the Feature's draft pull request, once the run has opened or updated it
	private pullUrl: string | null = null;
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

	// Where the run is and what its Status note lists, for a fault that escapes it.
	whereabouts(): FaultRun {
		return {
			place: this.place,
			tickets: this.listed(),
			session: this.session,
			pull: this.pullUrl
		};
	}

	// The Workflow's Steps at one point, the place a fault would name.
	private runSteps(steps: WorkflowRun, ticket: Ticket | null): Promise<Step> {
		const workflow = this.workflow?.name ?? null;
		this.place = { kind: 'step', workflow, ticket: ticket?.id ?? null };
		return ticket === null
			? steps.runAt('afterAllTickets', null)
			: steps.runAt('afterEachTicket', ticket);
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
			last = await this.runSteps(this.steps, null);
		}
		if (last.kind === 'next' && !this.aborted) last = await this.answerFeedback();
		return this.finish(last);
	}

	// One Feedback round when the branch's open pull request has trusted feedback no commit answers yet; one that fails is thrown away and handed to a person, and the run goes on.
	private async answerFeedback(): Promise<Step> {
		const { deps } = this;
		this.place = { kind: 'feedback' };
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
			allowance: allowanceOf(deps),
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
				// the comment notifies now; the Status note says it with the pull request's, once the run ends
				this.feedbackAsk = { ...thrownAwayAsk(end), next };
				await postAsk(deps.tracker, {
					to: this.feature.id,
					feature: this.feature.id,
					ask: this.feedbackAsk,
					session: this.session
				});
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
			log: (entry, of) => {
				this.log(entry, workOf(entry.step), of);
			},
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
			allowance: allowanceOf(this.deps),
			aborted: () => this.aborted
		});
	}

	// Why the day is over, once its spend reached the limit; the caps of the Sessions running in other Slots only make a Session wait where it starts.
	private dailyPause(): string | null {
		return this.deps.spend.dayOver(this.deps.now(), this.setup.limits.dailyUsd);
	}

	// the Status note is Nightjar's own summary, so it never reaches the Coding agent
	private async trusted(id: ItemId): Promise<Comment[]> {
		const comments = await this.deps.tracker.comments(id);
		return comments.filter((c) => c.trusted && !isStatusNote(c.body));
	}

	private log(entry: LogEntry, work: Work = workOf(entry.step), stepRound?: StepRound) {
		this.costs.push({
			ticket: entry.ticket,
			work,
			usd: entry.costUsd,
			...(stepRound === undefined ? {} : { stepRound }),
			...modelsOf(entry)
		});
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

	// Hands a Ticket to a person: no code kept on the branch, the reason on the Ticket in a comment that stands on its own. `session` is the Session that ended the Ticket, when one ran; `ask.output` is quoted only while no pull request holds the Feature's output.
	private async handBack(
		ticket: Ticket,
		before: string,
		ask: Pick<WaitingComment, 'mark' | 'sentence' | 'cause' | 'output'>,
		kind: TicketHandBack,
		why: string,
		session: string | null
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
		const { output, ...rest } = ask;
		const quoted =
			output !== undefined && (await this.deps.codeHost.openPull(this.tree.at.branch)) === null;
		const link = await postAsk(this.deps.tracker, {
			to: ticket.id,
			feature: this.feature.id,
			ask: { ...rest, cause: `${ask.cause}${kept}`, ...(quoted ? { output } : {}), next },
			session
		});
		if (link !== undefined) this.handBackLinks.set(ticket.id, link);
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

	// The Tickets as the Status note lists them, `current` the one being built.
	private listed(current: ItemId | null = null): NoteTicket[] {
		return noteTickets(this.feature, this.tickets, this.built, current, this.handBackLinks);
	}

	// The Status note while `ticket` builds: Building, which Ticket of the Feature's it is, and the Tickets with their states. It rewrites the note and posts no comment.
	private async noteBuilding(
		ticket: Ticket,
		at: Omit<Parameters<typeof buildingSentence>[0], 'ticket'> = {}
	): Promise<void> {
		const listed = this.listed(ticket.id);
		const place = listed.findIndex((t) => t.id === ticket.id) + 1;
		const listing = place > 0 ? { place, of: listed.length, title: ticket.title } : null;
		await writeStatusNote(this.deps, this.feature, {
			state: 'building',
			sentence: buildingSentence({ ticket: listing, ...at }),
			tickets: listed,
			pull: null,
			next: null,
			session: this.session
		});
	}

	// The Ticket carries the working Signal from just before its build Session starts until it ends any way: built, handed back, paused or stopped.
	private async buildTicket(ticket: Ticket): Promise<Step> {
		this.place = { kind: 'ticket', ticket: ticket.id };
		this.note({ kind: 'ticketStarted', ticket: ticket.id });
		const before = await this.tree.head();
		const faults = ticketFaults(ticket.body);
		// a Ticket that fails its contract starts no Session, so it is not shown as building
		if (faults.length === 0) await this.noteBuilding(ticket);
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
				{
					sentence: 'Nightjar did not start this Ticket: it does not meet the Ticket contract.',
					cause: faults.map((f) => `- ${f}`).join('\n')
				},
				'retry',
				`it fails the Ticket contract: ${faults.join(' ')}`,
				null
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
			enough: (usd) => allowanceOf(this.deps)(usd, 0).enough,
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
					...modelsOf(failed),
					outcome: `failed: ${failed.why}`,
					failure: 'passing'
				}),
			retrying: async (attempt, why) => {
				this.deps.say(
					`${hash(ticket.id)}: ${why}; retrying after a passing fault, try ${String(attempt)} of ${String(TRIES)}`
				);
				await this.noteBuilding(ticket, { retry: { attempt, of: TRIES } });
			}
		});
		const sessionId = got.sessionId;
		const entry = {
			ticket: ticket.id,
			step: 'build' as const,
			session: sessionId,
			costUsd: got.costUsd,
			...modelsOf(got)
		};

		switch (got.kind) {
			case 'aborted':
				this.log({ ...entry, outcome: 'stopped by a person' });
				await this.throwAway(before, ticket.id, STOPPED);
				return { kind: 'aborted' };
			case 'paused':
				await this.throwAway(before, ticket.id, `paused: ${got.why}`);
				this.log({ ...entry, outcome: `paused: ${got.why}` });
				return { kind: 'paused', why: got.why, ...resetOf(got) };
			case 'failed': {
				this.log({ ...entry, outcome: `failed: ${got.why}`, failure: got.failure });
				if (got.failure === 'lasting') this.lastFailure = got.why;
				// a reason of one line is the headline's; any more it printed is the output
				const [first = '', ...more] = got.why.split('\n');
				await this.handBack(
					ticket,
					before,
					{
						sentence: `Nightjar could not build this Ticket: ${first.trim()}.`,
						cause: failureCause[got.failure],
						...(more.join('\n').trim() === '' ? {} : { output: more.join('\n') })
					},
					'retry',
					got.why,
					sessionId
				);
				return NEXT;
			}
			case 'questions': {
				const round = questionRounds(ticketComments) + 1;
				this.log({ ...entry, outcome: `questions, round ${String(round)}` });
				await this.askAbout(ticket, before, got.questions, round, sessionId);
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
		round: number,
		session: string
	) {
		const limit = this.setup.limits.questionRounds;
		if (round <= limit) {
			const asked = `it asked ${String(questions.length)} question${questions.length === 1 ? '' : 's'}, round ${String(round)}`;
			await this.handBack(
				ticket,
				before,
				{
					// the mark is how the next run counts the question rounds
					mark: QUESTIONS_MARK,
					sentence: `Nightjar needs answers before it builds this Ticket (round ${String(round)}).`,
					cause: questionList(questions)
				},
				'answer',
				asked,
				session
			);
			return;
		}
		const asked = questions.map((q, i) => `${String(i + 1)}. ${q.question}`).join('\n');
		await this.handBack(
			ticket,
			before,
			{
				sentence: `Nightjar asked about this Ticket ${String(limit)} times and still has questions, so it needs a person.`,
				cause: asked
			},
			'human',
			`still unclear after ${String(limit)} question rounds, so a person builds it`,
			session
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
				{
					sentence: "Nightjar's Session said it built this Ticket but changed no file.",
					cause: 'Nothing was committed, so the Ticket is still unbuilt.'
				},
				'retry',
				'it said it built the Ticket but changed no file',
				sessionId
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
		await this.noteBuilding(ticket, { built: true });
		// later Tickets would build on red, so the run stops here and a person looks
		if (!check.ok) return { kind: 'red', tail: check.tail };
		return this.steps === null ? NEXT : this.runSteps(this.steps, ticket);
	}

	private fixUntilGreen(o: FixWork): Promise<FixEnd> {
		return fixUntilGreen(
			{
				deps: this.deps,
				setup: this.setup,
				tree: this.tree,
				building: (ticket, session, rounds, attempt) =>
					this.building(ticket, 'fix', session, rounds, attempt),
				log: (entry, work) => {
					this.log(entry, work, o.stepRound);
				},
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
		this.session = session;
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
		let paused: Pause | null = last.kind === 'paused' ? { why: last.why, ...resetOf(last) } : null;
		this.place = { kind: 'pull' };
		await this.signals.off('working');
		if (this.aborted || last.kind === 'aborted') return this.stopped();
		if (paused) await this.pause(paused.why);
		const repeated =
			last.kind === 'repeated'
				? `${String(last.tickets.length)} Tickets in a row failed with the same reason, ${last.tickets.map(hash).join(', ')}: ${last.why}.\n\n`
				: '';
		if ((await this.tree.ahead()) === 0) {
			if (paused) return { kind: 'paused', ...paused };
			const next = featureAfterRunStep(this.setup.signals, {
				waiting: left.length > 0,
				red: false
			});
			const why =
				last.kind === 'repeated' ? `Tickets keep failing: ${last.why}` : 'it built nothing';
			this.deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why, next });
			this.note({ kind: 'handed', to: 'needsInfo', why });
			await this.signals.on('needsInfo');
			await askAPerson(this.deps, this.feature, {
				ask: {
					sentence:
						last.kind === 'repeated'
							? 'Nightjar stopped building this Feature and built nothing.'
							: 'Nightjar built nothing for this Feature.',
					cause: `${repeated}${waitingList(left)}`,
					next
				},
				tickets: this.listed(),
				session: this.session
			});
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
					await this.pause(paused.why);
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
					await this.pause(paused.why);
				}
			} else {
				review = got;
				reviewSessions = [{ kind: 'review', review: got }];
			}
		}
		this.place = { kind: 'pull' };
		const carries = this.answered === null ? 'build' : 'feedbackRound';
		const of = { feature: id, note: this.note, signals: this.signals };
		const pushed = await pushBranch(this.deps, this.setup, this.tree, of, carries);
		if (pushed.kind === 'diverged') {
			// a pause put the Go back, and the Feature is now with a person
			await tracker.removeSignal(id, 'go');
			return { kind: 'diverged', side: pushed.side };
		}
		if (pushed.kind === 'fault') throw pushed.fault;
		const complete = left.length === 0 && red === null && paused === null;
		const ids = done.map((t) => t.id);
		const workflow = this.steps?.section(ids, (n) => tracker.reference(n).text) ?? null;
		// every round the branch had, from the ledger, so a run without one still shows the earlier ones
		const rounds = feedbackRounds(this.deps.spend.entries(), this.setup.repo, this.tree.at.branch);
		const pausedUntil = paused === null ? undefined : this.pausedUntil();
		const body = pullBody({
			// the line the Status note opens with at the end of this run
			headline: this.pullHeadline({
				left,
				red,
				repeated,
				paused: paused?.why ?? null,
				pausedUntil,
				complete,
				handsReview: open !== null && review !== null && review !== 'off',
				handsNote: complete && this.workflow?.workflow.output === 'note'
			}),
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
			paused: paused?.why ?? null,
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
		// what hands the Feature to a person, with its own Next step: one new comment, and the Status note says it
		let ask: Ask | null = null;
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
			ask = {
				sentence: STILL_NEEDS_A_PERSON,
				cause: `${repeated}${failing}${waitingList(left)}`,
				// the pull request body holds the check's output, or the list of waiting Tickets
				pull: { url: pull.url, section: red ? 'The check fails' : 'Waiting' },
				next
			};
		} else if (open !== null && review !== null && review !== 'off') {
			ask = await this.handReview(pull, open, review);
		} else if (complete && this.workflow?.workflow.output === 'note') {
			ask = await this.handNote(pull);
		}
		if (ask !== null) {
			await postAsk(tracker, { to: id, feature: id, ask, session: this.session });
		}
		// a Feedback round thrown away earlier in the run already told the person; its words stay in the note unless something later asks for them
		const waits = ask ?? this.feedbackAsk;
		if (waits !== null) {
			await noteWaiting(this.deps, this.feature, {
				ask: waits,
				tickets: this.listed(),
				session: this.session
			});
		} else if (paused !== null) {
			// the Go is back on the Feature, so it reads Paused, now with its pull request
			await this.notePaused(paused.why, pausedUntil);
		} else {
			await writeStatusNote(this.deps, this.feature, {
				state: 'pull',
				sentence: this.builtSentence(),
				tickets: this.listed(),
				pull: { url: pull.url },
				next: draftStep(pull.url),
				session: this.session
			});
		}
		return {
			kind: 'pull',
			pull,
			built: [...this.built],
			waiting: left,
			...(paused === null ? {} : { pause: paused })
		};
	}

	// A stop notifies no one: the Status note says Stopped, with how to run the Feature again. A Tracker without a Status note hears it in a comment, as before it kept one.
	private async stopped(): Promise<FeatureOutcome> {
		const { tracker } = this.deps;
		const next = stoppedStep(this.setup.signals);
		if (tracker.statusNote === undefined) {
			await tracker.comment(
				this.feature.id,
				withNext('The Nightjar run was stopped by a person.', next)
			);
		} else {
			await writeStatusNote(this.deps, this.feature, {
				state: 'stopped',
				sentence: 'by a person.',
				tickets: this.listed(),
				pull: this.pullUrl === null ? null : { url: this.pullUrl },
				next,
				session: this.session
			});
		}
		return { kind: 'stopped' };
	}

	// When a paused run tries the Feature again, as an ISO date; nothing when nothing does so on its own.
	private pausedUntil(): string | undefined {
		const { pauseMs, now } = this.deps;
		return pauseMs === undefined ? undefined : new Date(now().getTime() + pauseMs).toISOString();
	}

	// What the Status note says of a Feature built into a draft pull request.
	private builtSentence(): string {
		if (this.feature.lone === true) return 'Nightjar built this issue into a draft pull request.';
		const total = this.tickets.length;
		const builtHere = this.tickets.filter((t) => this.built.has(t.id)).length;
		return `Nightjar built ${String(builtHere)} of ${String(total)} Ticket${total === 1 ? '' : 's'} into a draft pull request.`;
	}

	// The line the pull request body opens with: the one the Status note opens with when this run ends, from the same wording function. It follows the order `finish` chooses what the run ends in.
	private pullHeadline(o: {
		readonly left: readonly Waiting[];
		readonly red: object | null;
		readonly repeated: string;
		readonly paused: string | null;
		readonly pausedUntil: string | undefined;
		readonly complete: boolean;
		readonly handsReview: boolean;
		readonly handsNote: boolean;
	}): string {
		const asks = !o.paused && (o.left.length > 0 || o.red !== null || o.repeated !== '');
		if (asks) return headline('waiting', STILL_NEEDS_A_PERSON);
		if (o.handsReview) return headline('waiting', REVIEW_ASKS);
		if (o.handsNote) return headline('waiting', NOTE_WAITS);
		if (this.feedbackAsk !== null) return headline('waiting', this.feedbackAsk.sentence);
		if (o.paused !== null) return headline('paused', pausedSentence(o.paused), o.pausedUntil);
		return headline('pull', this.builtSentence());
	}

	// The Status note of a paused run: Paused, until the run tries the Feature again when it does so on its own, and why. It notifies no one.
	private notePaused(why: string, until: string | undefined = this.pausedUntil()): Promise<void> {
		return writeStatusNote(this.deps, this.feature, {
			state: 'paused',
			...(until === undefined ? {} : { until }),
			sentence: pausedSentence(why),
			tickets: this.listed(),
			pull: this.pullUrl === null ? null : { url: this.pullUrl },
			next: pausedStep(until !== undefined),
			session: this.session
		});
	}

	private review(done: readonly Ticket[], declined: readonly Declined[] = []) {
		this.place = { kind: 'review' };
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
		readonly paused: Pause | null;
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
			this.place = { kind: 'reviewRound', round };
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
				allowance: allowanceOf(deps),
				fix: (work) => this.fixReviewRound(work, { round, rounds }),
				log: (entry) => this.log(entry),
				building: (session) => this.building(null, 'reviewRound', session, { round, rounds })
			});
			if (end.kind === 'paused') {
				return {
					review,
					sessions,
					paused: { why: end.why, ...resetOf(end) },
					stopped: false,
					open: null,
					declined
				};
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
	private async handReview(pull: Pull, open: ReviewLeftOpen, review: Review): Promise<Ask> {
		const id = this.feature.id;
		const next = reviewStep(this.setup.signals);
		const why =
			open.kind === 'failed'
				? `its Review round ${String(open.round)} was thrown away: ${open.why}`
				: 'its Review still asks for changes';
		this.deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why, next });
		this.note({ kind: 'handed', to: 'human', why });
		await this.signals.on('human');
		return {
			sentence: REVIEW_ASKS,
			cause: reviewOpenCause(open, review),
			// the pull request body holds the issues the Review found
			pull: { url: pull.url, section: 'Review' },
			next
		};
	}

	// A note is findings for a person, never a change to merge unread: the Feature is handed to them to read it.
	private async handNote(pull: Pull): Promise<Ask> {
		const id = this.feature.id;
		const next = noteStep(pull.url);
		const why = 'its note is for a person to read';
		this.deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why, next });
		this.note({ kind: 'handed', to: 'human', why });
		await this.signals.on('human');
		return {
			sentence: NOTE_WAITS,
			cause: `The note is under \`${NOTES_FOLDER}/\` in ${pull.url}. It holds findings, not code.`,
			pull: { url: pull.url },
			next
		};
	}

	// The Go back, so a later run goes on from the branch, and the Status note says Paused and why; a pause notifies no one.
	private async pause(why: string): Promise<void> {
		this.note({ kind: 'paused', why });
		await this.signals.on('go');
		this.deps.say(`paused: ${why}`);
		this.deps.status.doing({ kind: 'paused', why, until: null });
		await this.notePaused(why);
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
			this.pullUrl = open.url;
			return open;
		}
		const made = await codeHost.createDraft({
			title: this.feature.title,
			head: this.tree.at.branch,
			base: this.setup.baseBranch,
			body
		});
		this.note({ kind: 'pullOpened', url: made.url, created: true });
		this.pullUrl = made.url;
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
	const allowance = allowanceOf(deps);
	const summaries: string[] = [];
	const work: Work = o.of.kind === 'step' ? 'steps' : 'fix';
	let { check, spent } = o;
	for (let round = 1; !check.ok && round <= limits.fixRounds; round += 1) {
		const { usd: budget, enough } = allowance(o.cap, spent);
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
			enough: (usd) => allowance(usd, 0).enough,
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
						...modelsOf(failed),
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
		const entry = {
			ticket: o.ticket,
			step: 'fix' as const,
			session: o.sessionId,
			costUsd: got.costUsd,
			...modelsOf(got)
		};
		if (got.kind === 'paused') {
			ctx.log({ ...entry, outcome: `paused: ${got.why}` }, work);
			return { check, spent, summaries, halt: { kind: 'paused', why: got.why, ...resetOf(got) } };
		}
		// the ledger names a fix round that failed or was stopped as one that gave up
		const gaveUp = got.kind !== 'fixed';
		ctx.log(
			{
				...entry,
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
	// a green fix whose push was rejected because a person pushed to the branch: it waits on `side`, and the Feature is handed to a person
	| {
			readonly kind: 'diverged';
			readonly pull: Pull;
			readonly round: number;
			readonly side: string;
			readonly usd: number;
	  }
	// a green fix whose push failed on a fault: the queue hands the Feature back with needs info
	| {
			readonly kind: 'faulted';
			readonly pull: Pull;
			readonly round: number;
			readonly fault: unknown;
			readonly title: string;
			readonly usd: number;
	  }
	// the pull request is not Nightjar's to fix after all; nothing was done
	| { readonly kind: 'skipped'; readonly why: string }
	| ({ readonly kind: 'paused' } & Pause)
	| { readonly kind: 'stopped' };

// How a Pull-check fix round that ran ended: the outcomes that are not about a round that never began.
type PullFixRound = Exclude<PullFixOutcome, { readonly kind: 'atLimit' | 'skipped' }>;

// One Pull-check fix round on a red draft pull request: a Session that resumes the head commit's, or a new one where this machine lacks it, the repo's check with the usual fix rounds, and a new commit pushed only when it is green. No review and no Step runs after it.
// A fault that escapes it is thrown as a BuildFault that names the round.
export async function fixPullChecks(
	deps: Deps,
	setup: Setup,
	red: RedDraft
): Promise<PullFixOutcome> {
	const where: { run: FaultRun; note: Note | null } = {
		run: {
			place: { kind: 'pullFix', round: null },
			tickets: [],
			session: null,
			pull: red.draft.pull.url
		},
		note: null
	};
	try {
		return await fixRedDraft(deps, setup, red, where);
	} catch (fault) {
		throw faultAt(fault, where.run, where.note);
	}
}

async function fixRedDraft(
	deps: Deps,
	setup: Setup,
	red: RedDraft,
	where: { run: FaultRun; note: Note | null }
): Promise<PullFixOutcome> {
	const { tracker } = deps;
	const { draft } = red;
	const { pull } = draft;
	const day = deps.spend.dayOver(deps.now(), setup.limits.dailyUsd);
	if (day !== null) return { kind: 'paused', why: day };
	const feature = await tracker.feature(red.feature);
	const note = noteFor(deps.logbook, feature.id, deps.now);
	where.note = note;
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
		await handOver(
			deps,
			setup,
			{ feature, note, signals, built: await tree.built(), session: headSession ?? null },
			draft,
			why,
			draft.body
		);
		return { kind: 'atLimit', pull, rounds };
	}
	const round = used + 1;
	deps.say(`${hash(feature.id)}: the Pull checks of ${pull.url} fail, fix ${String(round)}`);
	// the head commit's Session where this machine still has it, else a new one
	const session: PullFixSession =
		headSession !== undefined && deps.sessionExists(headSession)
			? { kind: 'resume', id: headSession }
			: { kind: 'fresh', id: deps.newId() };
	where.run = { ...where.run, place: { kind: 'pullFix', round }, session: session.id };
	if (session.kind === 'fresh') {
		deps.say(
			`${hash(feature.id)}: ${headSession === undefined ? 'the head commit names no Session' : `Session ${headSession} is not on this machine`}, starting a new one`
		);
	}
	await signals.on('working');
	let got: PullFixRound;
	try {
		got = await pullFixRound(deps, setup, { feature, tree, draft, session, round, note, signals });
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
			...(got.kind === 'faulted' ? { why: why(got.fault) } : {}),
			session: session.id
		});
		// a push that faulted ends the round as any fault does: in the Logbook with its stack, naming the round for the hand-back
		if (got.kind === 'faulted') got = { ...got, fault: faultAt(got.fault, where.run, note) };
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
			await handOver(
				deps,
				setup,
				{ feature, note, signals, built: await tree.built(), session: session.id },
				draft,
				why,
				body
			);
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
		case 'faulted':
			return 'faulted';
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

// The Feature is a person's now: needs a person on it, a comment naming the pull request and its failing Pull checks, the Status note saying Waiting on you, and a mark in the body so the pass leaves it alone once the Signal comes off.
async function handOver(
	deps: Deps,
	setup: Setup,
	of: {
		readonly feature: Feature;
		readonly note: Note;
		readonly signals: FeatureSignals;
		// the Tickets the branch built
		readonly built: ReadonlySet<ItemId>;
		// the Session the round ran in, when one did
		readonly session: string | null;
	},
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
	const tickets = await deps.tracker.tickets(feature.id);
	const sentence = `Nightjar could not make the Pull checks of its pull request green: ${why}.`;
	await askAPerson(deps, feature, {
		ask: {
			sentence,
			cause: `Failing Pull checks:\n\n${failing.join('\n')}`,
			// the pull request body holds each round and the checks it left failing
			pull: { url: pull.url, section: 'Pull checks' },
			next: pullChecksStep(setup.signals)
		},
		tickets: noteTickets(feature, tickets, of.built),
		session: of.session
	});
	// the body says what the Status note now says
	await deps.codeHost.editBody(
		pull,
		withHeadline(markHandedOver(body), headline('waiting', sentence))
	);
	deps.say(`${hash(feature.id)}: handed to a person, ${why}`);
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
		note: Note;
		signals: FeatureSignals;
	}
): Promise<PullFixRound> {
	const { feature, note, tree, draft, round } = o;
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
	// Takes the branch back to `before`; what the round left is kept on an attempt branch, which the Logbook names with `why`.
	const throwAway = async (why: string): Promise<string | null> => {
		const side = await tree.discard(before, `pull-fix-${String(round)}`);
		if (side !== null) note({ kind: 'thrownAway', branch: side, why, session });
		return side;
	};
	const gaveUp = async (why: string, usd: number): Promise<PullFixRound> => {
		const side = await throwAway(why);
		deps.say(
			`${hash(feature.id)}: ${name} gave up: ${why}${side ? `; the attempt is kept on ${side}` : ''}`
		);
		return { kind: 'gaveUp', pull, round, why, usd };
	};
	const halted = async (halt: Halt): Promise<PullFixRound> => {
		await throwAway(haltWhy(halt));
		return halt.kind === 'paused'
			? { kind: 'paused', why: halt.why, ...resetOf(halt) }
			: { kind: 'stopped' };
	};

	building();
	const { pullFixUsd: cap, pullFixMinutes: minutes } = setup.limits;
	const deadline = deps.now().getTime() + minutes * 60_000;
	// why the round stopped short of a green check: one of its own caps, else the fix rounds ran out
	const stillRed = (spent: number) => {
		if (!allowanceOf(deps)(cap, spent).enough) {
			return `it reached its cap of ${dollars(cap)}`;
		}
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
	const entry = {
		ticket: null,
		step: 'pullChecks' as const,
		session,
		costUsd: got.costUsd,
		...modelsOf(got)
	};
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
			note
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
	const of = { feature: feature.id, note: o.note, signals: o.signals };
	const pushed = await pushBranch(deps, setup, tree, of, 'pullFix');
	if (pushed.kind === 'diverged') {
		return { kind: 'diverged', pull, round, side: pushed.side, usd: fixed.spent };
	}
	if (pushed.kind === 'fault') {
		return {
			kind: 'faulted',
			pull,
			round,
			fault: pushed.fault,
			title: feature.title,
			usd: fixed.spent
		};
	}
	deps.say(`${hash(feature.id)}: ${name} pushed to ${pull.url}`);
	return { kind: 'fixed', pull, round, summary, usd: fixed.spent };
}

// How a push ended: on the Code host; set aside on `side` because a person pushed first; or failed on a fault.
export type PushEnd =
	| { readonly kind: 'pushed' }
	| { readonly kind: 'diverged'; readonly side: string }
	| { readonly kind: 'fault'; readonly fault: unknown };

// What a push carries: on a fault a Pull-check fix is set aside, and a Feedback round's commit too unless an unpushed Ticket's commit lies under it.
type Carries = 'build' | 'feedbackRound' | 'pullFix';

// Every push of a Feature's branch; a failure is sorted by git, never by the message (ADR 0010).
async function pushBranch(
	deps: Deps,
	setup: Setup,
	tree: Worktree,
	of: { readonly feature: ItemId; readonly note: Note; readonly signals: FeatureSignals },
	carries: Carries
): Promise<PushEnd> {
	const { feature, note, signals } = of;
	const { branch } = tree.at;
	try {
		await deps.codeHost.push(tree.at.folder, branch);
		return { kind: 'pushed' };
	} catch (fault) {
		const outcome = await tree.pushOutcome();
		if (outcome === 'pushed') {
			deps.say(
				`${hash(feature)}: the push of ${branch} failed, yet the Code host holds it: ${why(fault)}`
			);
			return { kind: 'pushed' };
		}
		if (outcome === 'fault') {
			return { kind: 'fault', fault: await setAsideOnFault(tree, note, carries, fault) };
		}
		const side = await tree.setAsidePush();
		// a branch that diverged has a remote head, so none to go back to is a fault like any other
		if (side === null) return { kind: 'fault', fault };
		const moved = `${branch} moved on the Code host`;
		note({ kind: 'thrownAway', branch: side, why: moved });
		note({ kind: 'handed', to: 'human', why: moved });
		await signals.on('human');
		await deps.tracker.comment(feature, branchMovedComment(setup.signals, branch, side));
		deps.say(
			`${hash(feature)}: handed to a person, ${branch} moved on the Code host; the work is kept on ${side}`
		);
		return { kind: 'diverged', side };
	}
}

// The fault a push ended on, naming the side branch when the work was set aside so that no unpushed commit counts as done or holds a pass back.
async function setAsideOnFault(
	tree: Worktree,
	note: Note,
	carries: Carries,
	fault: unknown
): Promise<unknown> {
	const keeps =
		carries === 'build' || (carries === 'feedbackRound' && (await tree.holdsUnpushedTicket()));
	const side = keeps ? null : await tree.setAsidePush();
	if (side === null) return fault;
	note({ kind: 'thrownAway', branch: side, why: `its push failed: ${why(fault)}` });
	return new Error(`${why(fault)}; the work is kept on ${side}`);
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
): Promise<Review | null | { readonly paused: Pause }> {
	const before = await tree.head();
	const { outcome: got } = await retryPassing<ReviewOutcome>({
		budgetUsd: setup.limits.reviewUsd,
		enough: (usd) => allowanceOf(deps)(usd, 0).enough,
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
				...modelsOf(failed),
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
		costUsd: got.costUsd,
		...modelsOf(got)
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
			return { paused: { why: got.why, ...resetOf(got) } };
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

// The sentences a Feature with a draft pull request is handed to a person in, said by both the new comment and the headlines of the Status note and the pull request body.
const STILL_NEEDS_A_PERSON =
	'Nightjar opened a draft pull request, and this Feature still needs a person.';
const REVIEW_ASKS = 'Nightjar opened a draft pull request, and its Review still asks for changes.';
const NOTE_WAITS = 'Nightjar wrote a note for this Feature, and it waits for a person to read it.';

const pausedSentence = (why: string) => `${why.charAt(0).toUpperCase()}${why.slice(1)}.`;

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
	// the state word and sentence the body opens with, which the Status note opens with too
	headline: string;
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
		p.headline,
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

// Each Step after all Tickets on a line of its own, in the order they ran: `- w/polish: $9.80 (3 rounds: $4.10, $3.20, $2.50)`; a round's fix rounds count in it.
function stepLines(costs: readonly Cost[]): string[] {
	const after = costs.filter((c) => c.ticket === null && c.work === 'steps');
	const nameOf = (c: Cost) => c.stepRound?.name ?? 'Steps after all Tickets';
	return [...new Set(after.map(nameOf))].map((name) => {
		const own = after.filter((c) => nameOf(c) === name);
		const rounds = new Map<number, number>();
		for (const c of own) {
			const round = c.stepRound?.round ?? 1;
			rounds.set(round, (rounds.get(round) ?? 0) + c.usd);
		}
		const total = own.reduce((n, c) => n + c.usd, 0);
		const each = [...rounds].sort(([a], [b]) => a - b).map(([, usd]) => dollars(usd));
		const split = each.length > 1 ? ` (${String(each.length)} rounds: ${each.join(', ')})` : '';
		return `- ${name}: ${dollars(total)}${split}`;
	});
}

// Each model's dollars and tokens over the run's Sessions, and what the Sessions that named none cost; null when none did.
function modelLines(costs: readonly Cost[]): string | null {
	const models = byModel(costs);
	if (models.length === 0) return null;
	const line = (m: ModelUsage) => `- ${m.model}: ${dollars(m.costUsd)}; tokens: ${tokensText(m)}`;
	const lines = models.map(line);
	const bare = costs.filter((c) => c.models === undefined);
	if (bare.length > 0)
		lines.push(`- models not recorded: ${dollars(bare.reduce((n, c) => n + c.usd, 0))}`);
	return `### By model\n\n${lines.join('\n')}`;
}

// The total, then what each Ticket cost by kind of work, each Step after all Tickets with its rounds, the Feedback round, the review and its rounds, and then each model; a kind with no Session is left out.
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
	lines.push(...stepLines(costs));
	if (has(null, 'feedback')) lines.push(`- Feedback round: ${dollars(sum(null, 'feedback'))}`);
	if (has(null, 'review')) lines.push(`- Review: ${dollars(sum(null, 'review'))}`);
	if (has(null, 'reviewRound')) lines.push(`- Review rounds: ${dollars(sum(null, 'reviewRound'))}`);
	const head = `## Cost\n\nEstimated cost of this run: ${dollars(spent)}.`;
	const models = modelLines(costs);
	return [head, lines.join('\n'), models ?? ''].filter((part) => part !== '').join('\n\n');
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

// What the last Review left open, in a line or two: the pull request's Review section holds the issues.
function reviewOpenCause(open: ReviewLeftOpen, review: Review): string {
	const cause =
		open.kind === 'failed'
			? `Review round ${String(open.round)} was thrown away: ${open.why}.${open.side === null ? '' : ` Its work is kept on the branch \`${open.side}\`.`} No more Review rounds ran. The last Review said changes`
			: `Nightjar ran ${String(open.rounds)} Review round${open.rounds === 1 ? '' : 's'}, and the last Review still says changes`;
	return `${cause}: ${review.summary}`;
}

// What a Feature is told when a push of its branch is rejected because a person pushed to it, whatever the push followed.
export function branchMovedComment(n: SignalNames, branch: string, side: string): string {
	return withNext(
		`Nightjar could not push to \`${branch}\`: the branch moved on the Code host while Nightjar worked, so a person has pushed to it. Nightjar set its own work aside on the local branch \`${side}\`, put \`${branch}\` back at the Code host's head, and will not push to it again on its own.`,
		pushRejectedStep(n, side)
	);
}

function reviewComment(review: Review): string {
	const issues = issueLines(review.issues);
	return `**Nightjar review: ${review.verdict === 'approve' ? 'approve' : 'changes'}**\n\n${review.summary}${issues ? `\n\n${issues}` : ''}${FOOTER}`;
}
