// --once, --watch, nightjar <id> and doctor: which Feature to build next, which conflicting or red draft pull request the revisit passes fix first, and what happens to a Feature whose build fails on a fault.
import {
	askAPerson,
	featureOfBody,
	handedOver,
	noteTickets,
	type ConflictFixOutcome,
	type ConflictingDraft,
	type FeatureOutcome,
	type Pause,
	type PullFixOutcome,
	type RedDraft
} from './build.js';
import type { ChangeRequest, CodeHost, NightjarDraft, OpenPull } from './code-host.js';
import { AUTOMATIC_ROUNDS, feedbackHistory, newRequest } from './feedback-round.js';
import { BuildFault, faultAsk, passingFault } from './fault.js';
import { FOOTER } from './footer.js';
import { faultStep, feedbackLimitStep } from './next-step.js';
import { NEEDS_A_PERSON, NEEDS_INFO } from './plan.js';
import { markPublished, readyToPublish } from './publish.js';
import type { Signal, SignalNames } from './signals.js';
import { BRANCH_PREFIX, branchFor, builtOn } from './worktree.js';
import {
	waitingTickets,
	type Named,
	type StatusReport,
	type TicketCounts,
	type WaitingItem
} from './status.js';
import type { ItemId, Tracker } from './tracker.js';
import { why } from './say.js';
import type { Newer } from './stale.js';
import type { PortLease } from './ports.js';

import { DEFAULT_POLL_SECONDS } from './person-config.js';

export const POLL_MS = DEFAULT_POLL_SECONDS * 1000;
// how long --watch waits after a pause (the daily limit, the plan's usage limit) before it looks again
export const PAUSE_MS = 30 * 60_000;

export type Say = (line: string) => void;

// The variables that hand a piece of work its block of ports.
export type PortEnv = Readonly<Record<string, string>>;

export interface QueueDeps {
	readonly tracker: Tracker;
	// whose Features to build
	readonly person: string;
	// `say` is the Slot's own, which marks each line with the Feature's id when the run holds several Slots; `portEnv` is the block of ports the Slot claimed for this work, when the repo reserves ports
	readonly build: (feature: Named, say: Say, portEnv?: PortEnv) => Promise<FeatureOutcome>;
	// Claims a block of ports for a Slot's work, or null when none is free; left out when the repo reserves none. The queue releases the lease when the work ends.
	readonly claimPorts?: () => Promise<PortLease | null>;
	readonly status: StatusReport;
	readonly now: () => Date;
	readonly say: Say;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly signal?: AbortSignal;
	// how long --watch waits when idle; POLL_MS when left out
	readonly pollMs?: number;
	// how many Slots the run holds (--parallel, else config.json's parallel); 1 when left out
	readonly slots?: number;
	// --watch only: newer Nightjar code than the one running, checked while idle
	readonly newer?: Newer;
	// factory.json's Signal names, for the Next step of a Feature handed back on a fault
	readonly signals?: SignalNames;
	// the revisit pass, when factory.json turns it on and the Code host can list Nightjar's drafts
	readonly pullChecks?: PullChecksPass;
	// the Conflict fix pass, when factory.json turns `conflicts` on and the Code host can list Nightjar's drafts; --watch only
	readonly conflicts?: ConflictsPass;
	// Feedback rounds a trusted request for changes starts, when the Code host can list Nightjar's open pull requests and answer their feedback
	readonly feedback?: FeedbackPass;
	// Publish (docs/adr/0006), when factory.json sets `publish` and the Code host can publish and list Nightjar's drafts; --watch only
	readonly publish?: PublishPass;
}

export interface PublishPass {
	// the Code host's open drafts on Nightjar's branches
	readonly drafts: () => Promise<NightjarDraft[]>;
	// takes one draft out of draft, and marks its body so the Pull-check pass keeps to it
	readonly publish: (draft: NightjarDraft) => Promise<void>;
}

// The pass, or null when factory.json leaves `publish` off or the Code host cannot publish or list Nightjar's drafts.
export function publishPass(publish: boolean | undefined, codeHost: CodeHost): PublishPass | null {
	const list = codeHost.nightjarDrafts?.bind(codeHost);
	const take = codeHost.publish?.bind(codeHost);
	if (publish !== true || list === undefined || take === undefined) return null;
	return {
		// only Publish reads the commits, to see that no person pushed
		drafts: () => list({ commits: true }),
		publish: async (draft) => {
			await take(draft.pull);
			// its own Publish is no person engaging: the mark is what tells the Pull-check pass it may still fix this pull request
			await codeHost.editBody(draft.pull, markPublished(draft.body));
		}
	};
}

export interface FeedbackPass {
	// the open pull requests on Nightjar's branches
	readonly pulls: () => Promise<OpenPull[]>;
	// the Feature built with no Go, its Feedback round started by the request for changes `asked`
	readonly answer: (
		feature: Named,
		asked: string,
		say: Say,
		portEnv?: PortEnv
	) => Promise<FeatureOutcome>;
}

// Nightjar's open pull requests, or null when the Code host cannot list them or cannot answer their feedback.
function openPullsOf(codeHost: CodeHost): FeedbackPass['pulls'] | null {
	const list = codeHost.openPulls?.bind(codeHost);
	if (list === undefined || codeHost.feedback === undefined || codeHost.reply === undefined) {
		return null;
	}
	return () => list(BRANCH_PREFIX);
}

// The pass, or null when the Code host cannot list Nightjar's open pull requests or answer their feedback.
export function feedbackPass(
	codeHost: CodeHost,
	answer: FeedbackPass['answer']
): FeedbackPass | null {
	const pulls = openPullsOf(codeHost);
	return pulls === null ? null : { pulls, answer };
}

export interface PullChecksPass {
	// the Code host's open drafts on Nightjar's branches
	readonly drafts: () => Promise<NightjarDraft[]>;
	// one Pull-check fix round on a red draft
	readonly fix: (red: RedDraft, say: Say, portEnv?: PortEnv) => Promise<PullFixOutcome>;
}

// The revisit pass, or null when factory.json leaves it off or the Code host cannot list Nightjar's drafts.
export function pullChecksPass(
	pullChecks: { readonly enabled?: boolean | undefined } | undefined,
	codeHost: CodeHost,
	fix: PullChecksPass['fix']
): PullChecksPass | null {
	const list = codeHost.nightjarDrafts?.bind(codeHost);
	if (pullChecks?.enabled !== true || list === undefined) return null;
	return { drafts: list, fix };
}

export interface ConflictsPass {
	// the Code host's open drafts on Nightjar's branches
	readonly drafts: () => Promise<NightjarDraft[]>;
	// one Conflict fix on a draft that conflicts with its base
	readonly fix: (
		conflicting: ConflictingDraft,
		say: Say,
		portEnv?: PortEnv
	) => Promise<ConflictFixOutcome>;
}

// The Conflict fix pass, or null when factory.json leaves `conflicts` off or the Code host cannot list Nightjar's drafts.
export function conflictsPass(
	conflicts: { readonly enabled?: boolean | undefined } | undefined,
	codeHost: CodeHost,
	fix: ConflictsPass['fix']
): ConflictsPass | null {
	const list = codeHost.nightjarDrafts?.bind(codeHost);
	if (conflicts?.enabled !== true || list === undefined) return null;
	return { drafts: list, fix };
}

// The drafts that meet the four conditions of Publish, oldest first.
const readyDrafts = (drafts: readonly NightjarDraft[], now: Date) =>
	drafts.filter((d) => readyToPublish(d, now)).sort((a, b) => a.pull.id - b.pull.id);

// One draft Publish takes out of draft, the oldest that meets its four conditions, or null when none does. A pull request whose publishing failed is not tried again in this run.
async function publishNext(
	deps: QueueDeps,
	pass: PublishPass,
	failed: Set<number>
): Promise<NightjarDraft | null> {
	let drafts: NightjarDraft[];
	try {
		drafts = await pass.drafts();
	} catch (fault) {
		deps.say(`could not read Nightjar's draft pull requests: ${why(fault)}`);
		return null;
	}
	const next = readyDrafts(drafts, deps.now()).find((d) => !failed.has(d.pull.id));
	if (next === undefined) return null;
	try {
		await pass.publish(next);
		deps.say(`published ${next.pull.url}`);
		return next;
	} catch (fault) {
		failed.add(next.pull.id);
		deps.say(`could not publish ${next.pull.url}: ${why(fault)}`);
		return null;
	}
}

// Hands a Feature back to a person after a fault: the claim and the Go off, needs info on, and a new comment and the Status note naming where the fault happened, from a BuildFault, and whether giving the Go again is likely to help. The stack trace is in the Logbook, never here.
// A paused build puts the Go back before it pushes, so a fault after that would otherwise build it again on every pass.
export async function handBack(
	deps: QueueDeps,
	feature: Named,
	fault: unknown,
	startedAt?: string
): Promise<void> {
	const { tracker } = deps;
	const { id, title } = feature;
	const reason = why(fault);
	const at = fault instanceof BuildFault ? fault : null;
	const next =
		deps.signals === undefined
			? undefined
			: faultStep(deps.signals, {
					passing: passingFault(fault),
					pullFix: at?.place.kind === 'pullFix',
					conflictFix: at?.place.kind === 'conflictFix'
				});
	deps.say(`#${id} failed: ${reason}`);
	deps.status.happened({
		kind: 'failed',
		feature: id,
		title,
		why: reason,
		...(startedAt === undefined ? {} : { startedAt }),
		...(next === undefined ? {} : { next })
	});
	try {
		await tracker.removeSignal(id, 'working');
		await tracker.removeSignal(id, 'go');
		await tracker.addSignal(id, 'needsInfo');
		await askAPerson(
			deps,
			{ id },
			{
				ask: faultAsk({
					fault,
					place: at?.place ?? null,
					pull: at?.pull ?? null,
					next: next ?? []
				}),
				tickets: at?.tickets ?? [],
				session: at?.session ?? null
			}
		);
	} catch {
		// the Tracker itself may be the fault
	}
}

// One Feature; a fault after the claim leaves it with the person, not stuck as being worked on.
export async function buildOne(
	deps: QueueDeps,
	feature: Named,
	build: (feature: Named) => Promise<FeatureOutcome> = (f) => deps.build(f, deps.say)
): Promise<FeatureOutcome | null> {
	const startedAt = deps.now().toISOString();
	try {
		return await build(feature);
	} catch (fault) {
		await handBack(deps, feature, fault, startedAt);
		return null;
	}
}

const samePerson = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Why `nightjar <id>` may not claim this Feature, or null when it may. Working comes first: a claim takes the Go off.
export async function cannotClaim(
	deps: Pick<QueueDeps, 'tracker' | 'person'>,
	id: ItemId
): Promise<string | null> {
	const { assignees, signals, parent } = await deps.tracker.standing(id);
	// a Ticket is built by its Feature, so building it alone would build it twice
	if (parent !== undefined) {
		return `#${id} is a Ticket of #${parent}, so that Feature owns it and Nightjar leaves it alone. Build #${parent} instead.`;
	}
	if (signals.includes('working')) {
		return `#${id} already carries the working Signal: another run is building it, or one stopped without clearing it. If none is running, take the Signal off and run again.`;
	}
	if (!assignees.some((a) => samePerson(a, deps.person))) {
		return `#${id} is not assigned to ${deps.person}, so Nightjar leaves it alone. Assign it to ${deps.person} first.`;
	}
	if (!signals.includes('go')) {
		return `#${id} does not carry the Go, so Nightjar leaves it alone. Give it the Go first.`;
	}
	return null;
}

// The Features waiting on the person, each with the Signal it carries; the last answer when the Tracker fails, so a bad poll does not empty the panel.
async function readWaitingFeatures(
	deps: QueueDeps,
	previous: WaitingItem[]
): Promise<WaitingItem[]> {
	try {
		return ((await deps.tracker.waitingOn?.(deps.person)) ?? []).map((f) => ({
			kind: 'feature',
			id: f.id,
			title: f.title,
			why: f.signal === 'needsInfo' ? NEEDS_INFO : NEEDS_A_PERSON
		}));
	} catch (fault) {
		deps.say(`could not read what waits on ${deps.person}: ${why(fault)}`);
		return previous;
	}
}

// Tells the status file the Queue and Waiting on you, keeping the Features that wait from one read to the next.
function waitingOnYou(deps: QueueDeps) {
	const canList = deps.tracker.waitingOn !== undefined;
	let features: WaitingItem[] = [];
	// null for a Feature whose count could not be read; empty when the Tracker cannot count
	let counts = new Map<ItemId, TicketCounts | null>();
	// the counts of the Features in the Queue and in Waiting on you; a fault leaves every one unread, never the refresh broken
	const readCounts = async (queue: readonly Named[]) => {
		const count = deps.tracker.ticketCounts?.bind(deps.tracker);
		if (count === undefined) return;
		const ids = [...new Set([...queue, ...features].map((f) => f.id))];
		try {
			const got = await count(ids);
			counts = new Map(ids.map((id) => [id, got.get(id) ?? null]));
		} catch (fault) {
			deps.say(`could not count the Tickets of the Features: ${why(fault)}`);
			counts = new Map(ids.map((id) => [id, null]));
		}
	};
	const withCount = <T extends Named>(item: T): T =>
		counts.has(item.id) ? { ...item, ticketCounts: counts.get(item.id) ?? null } : item;
	return {
		read: async (queue: readonly Named[]) => {
			if (canList) features = await readWaitingFeatures(deps, features);
			await readCounts(queue);
		},
		// `tickets` are those of `built`, the Feature just built, which only a Feature that ended well says
		tell: (queue: Named[], outcome: FeatureOutcome | null = null, built: Named | null = null) => {
			const tickets =
				built !== null && (outcome?.kind === 'pull' || outcome?.kind === 'nothing')
					? waitingTickets(outcome.waiting, built.id)
					: [];
			deps.status.refreshed(queue.map(withCount), {
				items: [...features.map(withCount), ...tickets],
				trackerCannotList: !canList
			});
		}
	};
}

const named = ({ id, title }: Named): Named => ({ id, title });

// A draft is taken once per head commit in a run: a new commit, such as a pushed fix, makes it new again.
const triedKey = (d: NightjarDraft) => `${String(d.pull.id)} ${d.headCommit}`;

// A draft the Pull-check pass fixes: its Pull checks done and one red.
const isRed = ({ checks }: NightjarDraft) => !checks.pending && checks.failed.length > 0;

// A draft the Conflict fix pass takes: the Code host says it conflicts with its base. One it cannot say of, or one only behind its base, is left alone.
const isConflicting = (draft: NightjarDraft) => draft.conflicts === 'yes';

// The oldest draft a revisit pass may take: one `wanted` picks, no person engaged, not handed to a person, its body naming a Feature assigned to the person that holds no Signal.
async function nextDraft(
	deps: QueueDeps,
	listed: readonly NightjarDraft[],
	wanted: (draft: NightjarDraft) => boolean,
	tried: ReadonlySet<string>,
	// the Features in a Slot, which no other Slot takes
	busy: ReadonlySet<ItemId>,
	// `nightjar <id>`: only this Feature's draft
	only?: ItemId
): Promise<RedDraft | null> {
	const drafts = [...listed].sort((a, b) => a.pull.id - b.pull.id);
	for (const draft of drafts) {
		if (!wanted(draft) || draft.personEngaged) continue;
		if (tried.has(triedKey(draft))) continue;
		// handed to a person once, it stays theirs when they take needs a person off
		if (handedOver(draft.body)) continue;
		const feature = featureOfBody(draft.body);
		if (feature === undefined || (only !== undefined && feature !== only)) continue;
		if (busy.has(feature)) continue;
		try {
			const { assignees, signals } = await deps.tracker.standing(feature);
			if (!assignees.some((a) => samePerson(a, deps.person)) || signals.length > 0) continue;
		} catch (fault) {
			deps.say(`could not read #${feature} of ${draft.pull.url}: ${why(fault)}`);
			continue;
		}
		return { draft, feature };
	}
	return null;
}

// The red draft the revisit pass takes next, or null when none waits; a fault is said, and the Queue goes on.
async function findRed(
	deps: QueueDeps,
	pass: PullChecksPass,
	tried: ReadonlySet<string>,
	busy: ReadonlySet<ItemId>,
	only?: ItemId
): Promise<RedDraft | null> {
	try {
		return await nextDraft(deps, await pass.drafts(), isRed, tried, busy, only);
	} catch (fault) {
		deps.say(`could not read Nightjar's draft pull requests: ${why(fault)}`);
		return null;
	}
}

// The conflicting draft the Conflict fix pass takes next, or null when none waits; a fault is said, and the Queue goes on.
async function findConflicting(
	deps: QueueDeps,
	pass: ConflictsPass,
	tried: ReadonlySet<string>,
	busy: ReadonlySet<ItemId>
): Promise<ConflictingDraft | null> {
	try {
		return await nextDraft(deps, await pass.drafts(), isConflicting, tried, busy);
	} catch (fault) {
		deps.say(`could not read Nightjar's draft pull requests: ${why(fault)}`);
		return null;
	}
}

// One conflicting draft's Conflict fix; a fault is said, the Feature is handed back naming the Conflict fix, and the fix is skipped.
async function fixConflicting(
	deps: QueueDeps,
	pass: ConflictsPass,
	tried: Set<string>,
	conflicting: ConflictingDraft,
	say: Say,
	portEnv?: PortEnv
): Promise<ConflictFixOutcome> {
	try {
		const got = await pass.fix(conflicting, say, portEnv);
		// the day's limit holds it back, so it is taken once the day is over
		if (got.kind !== 'paused') tried.add(triedKey(conflicting.draft));
		if (got.kind === 'faulted') {
			await handBack(deps, { id: conflicting.feature, title: got.title }, got.fault);
		}
		return got;
	} catch (fault) {
		tried.add(triedKey(conflicting.draft));
		const reason = why(fault);
		say(`the Conflict fix of ${conflicting.draft.pull.url} stopped on a fault: ${reason}`);
		// a fault from before the fix named itself is still the Conflict fix's
		const at =
			fault instanceof BuildFault
				? fault
				: new BuildFault(fault, {
						place: { kind: 'conflictFix', round: null },
						tickets: [],
						session: null,
						pull: conflicting.draft.pull.url
					});
		const title = await deps.tracker.feature(conflicting.feature).then(
			(f) => f.title,
			() => ''
		);
		await handBack(deps, { id: conflicting.feature, title }, at);
		return { kind: 'skipped', why: reason };
	}
}

// One red draft's Pull-check fix round; a fault is said, and the round is skipped.
async function fixRed(
	deps: QueueDeps,
	pass: PullChecksPass,
	tried: Set<string>,
	red: RedDraft,
	say: Say,
	portEnv?: PortEnv
): Promise<PullFixOutcome> {
	try {
		const got = await pass.fix(red, say, portEnv);
		// the day's limit holds it back, so it is taken once the day is over
		if (got.kind !== 'paused') tried.add(triedKey(red.draft));
		// a fix whose push failed on a fault is handed back as a build is, so the Feature carries a Signal and a comment
		if (got.kind === 'faulted') {
			await handBack(deps, { id: red.feature, title: got.title }, got.fault);
		}
		return got;
	} catch (fault) {
		tried.add(triedKey(red.draft));
		const reason = why(fault);
		say(`the Pull-check fix of ${red.draft.pull.url} stopped on a fault: ${reason}`);
		// a fault from before the round named itself is still the Pull-check fix's
		const at =
			fault instanceof BuildFault
				? fault
				: new BuildFault(fault, {
						place: { kind: 'pullFix', round: null },
						tickets: [],
						session: null,
						pull: red.draft.pull.url
					});
		const title = await deps.tracker.feature(red.feature).then(
			(f) => f.title,
			() => ''
		);
		await handBack(deps, { id: red.feature, title }, at);
		return { kind: 'skipped', why: reason };
	}
}

// One red draft's Pull-check fix round, or null when none waits.
async function revisit(
	deps: QueueDeps,
	pass: PullChecksPass,
	tried: Set<string>,
	only?: ItemId,
	portEnv?: PortEnv
): Promise<PullFixOutcome | null> {
	const red = await findRed(deps, pass, tried, new Set(), only);
	return red === null ? null : fixRed(deps, pass, tried, red, deps.say, portEnv);
}

// Whether a round did a piece of work; a skipped one left the pull request alone, so the Queue's next work is still due.
const didWork = (got: PullFixOutcome | null): got is PullFixOutcome =>
	got !== null && got.kind !== 'skipped';

const PULL_FIX_GOOD_ENDS: readonly PullFixOutcome['kind'][] = [
	'fixed',
	'gaveUp',
	'atLimit',
	'diverged'
];

// The exit code of a run that ended on a Pull-check fix round: a fix pushed, or the Feature handed to a person, is a good end.
export function pullFixExit(got: PullFixOutcome): number {
	return PULL_FIX_GOOD_ENDS.includes(got.kind) ? 0 : 1;
}

const FEATURE_GOOD_ENDS: readonly FeatureOutcome['kind'][] = ['pull', 'nothing', 'diverged'];

// The exit code of `nightjar <id>` after a build: a pull request opened, nothing to build, or the Feature handed to a person is a good end.
export function featureExit(got: FeatureOutcome | null): number {
	return got !== null && FEATURE_GOOD_ENDS.includes(got.kind) ? 0 : 1;
}

// `nightjar <id>`: the Feature's red draft fixed, or null when the pass is off or that Feature has none to fix, so the Feature is built as today. `portEnv` is the block of ports the caller claimed for it.
export async function fixNamed(
	deps: QueueDeps,
	id: ItemId,
	portEnv?: PortEnv
): Promise<PullFixOutcome | null> {
	const pass = deps.pullChecks;
	if (pass === undefined) return null;
	const got = await revisit(deps, pass, new Set(), id, portEnv);
	if (got?.kind === 'paused') deps.say(got.why);
	return didWork(got) ? got : null;
}

// A Feature with no Go whose open pull request a trusted reviewer asked changes of since its last Feedback round.
interface AskedFeature {
	readonly feature: Named;
	readonly open: OpenPull;
	// the newest such request
	readonly request: ChangeRequest;
	readonly signals: readonly Signal[];
	// the Feedback rounds a request for changes started on the pull request, counted from its branch's trailers
	readonly rounds: number;
}

// The Features a trusted request for changes may start a Feedback round on, oldest pull request first: each assigned to the person, with no Go, not being worked on and not waiting on needs info, and on the branch its title names.
async function askedFeatures(
	deps: Pick<QueueDeps, 'tracker' | 'person' | 'say'>,
	pulls: readonly OpenPull[]
): Promise<AskedFeature[]> {
	const found: AskedFeature[] = [];
	for (const open of [...pulls].sort((a, b) => a.pull.id - b.pull.id)) {
		const request = newRequest(open);
		const id = featureOfBody(open.body);
		if (request === null || id === undefined) continue;
		try {
			const { assignees, signals } = await deps.tracker.standing(id);
			if (!assignees.some((a) => samePerson(a, deps.person))) continue;
			// a Feature with the Go is built as one, and its build answers the feedback
			if (signals.some((s) => s === 'go' || s === 'working' || s === 'needsInfo')) continue;
			const { title } = await deps.tracker.feature(id);
			// the build works on the branch the title names, so a pull request on another is not the one it would answer
			if (branchFor(id, title) !== open.branch) continue;
			const rounds = feedbackHistory(open.commits).automatic;
			found.push({ feature: { id, title }, open, request, signals, rounds });
		} catch (fault) {
			deps.say(`could not read #${id} of ${open.pull.url}: ${why(fault)}`);
		}
	}
	return found;
}

const atLimit = (a: AskedFeature) => a.rounds >= AUTOMATIC_ROUNDS;

const askedKey = (a: AskedFeature) => `${String(a.open.pull.id)} ${a.request.id}`;

const limitWhy = `its pull request has had its ${String(AUTOMATIC_ROUNDS)} automatic Feedback rounds`;

// A request for changes past the limit starts no round: the Feature gets needs a person and a comment saying why, once; a Feature that carries needs a person already is left alone.
async function feedbackLimit(deps: QueueDeps, a: AskedFeature): Promise<void> {
	const { id } = a.feature;
	const { author } = a.request;
	const { url } = a.open.pull;
	if (a.signals.includes('human')) return;
	deps.say(`#${id}: ${author} asked for changes on ${url}, and ${limitWhy}; handed to a person`);
	const next = deps.signals === undefined ? [] : feedbackLimitStep(deps.signals);
	try {
		await deps.tracker.addSignal(id, 'human');
		const feature = await deps.tracker.feature(id);
		const tickets = await deps.tracker.tickets(id);
		await askAPerson(deps, feature, {
			ask: {
				sentence: `Nightjar did not answer the changes ${author} asked for on its pull request.`,
				cause: `${limitWhy.charAt(0).toUpperCase()}${limitWhy.slice(1)}, and only a Go starts another.`,
				pull: { url },
				next
			},
			tickets: noteTickets(feature, tickets, builtOn(a.open.commits)),
			session: null
		});
	} catch (fault) {
		deps.say(`could not hand #${id} to a person: ${why(fault)}`);
	}
}

// The Feature whose Feedback round a trusted request for changes starts next, or null when none waits. A pull request is taken once per request in a run, so a round that lands no commit is not started again and again.
async function findAsked(
	deps: QueueDeps,
	pass: FeedbackPass,
	tried: Set<string>,
	busy: ReadonlySet<ItemId>
): Promise<AskedFeature | null> {
	let found: AskedFeature[];
	try {
		found = await askedFeatures(deps, await pass.pulls());
	} catch (fault) {
		deps.say(`could not read Nightjar's open pull requests: ${why(fault)}`);
		return null;
	}
	for (const a of found) {
		if (busy.has(a.feature.id)) continue;
		const key = askedKey(a);
		if (tried.has(key)) continue;
		if (atLimit(a)) {
			await feedbackLimit(deps, a);
			continue;
		}
		tried.add(key);
		return a;
	}
	return null;
}

const none = (deps: Pick<QueueDeps, 'person'>) =>
	`no Feature with the Go is assigned to ${deps.person}`;

// With several Slots, each line a Slot's work says starts with its Feature's id, so the lines of work running at once can be told apart.
export function slotSay(id: ItemId, say: Say): Say {
	const mark = `#${id}`;
	const marked = (line: string) => line.startsWith(mark) && !/^\w/.test(line.slice(mark.length));
	return (line) => say(marked(line) ? line : `${mark}: ${line}`);
}

// How a Slot's work ended: the exit code it gives --once, or null when it did no work, so the Slot takes the next; the pause it asks of the run; and the Feature it built, for Waiting on you.
interface Ended {
	readonly code: number | null;
	readonly paused?: Pause;
	readonly built?: { readonly feature: Named; readonly outcome: FeatureOutcome | null };
}

// A piece of work a free Slot takes: the Feature it holds the Slot for, and the work, which runs on the block of ports its Slot claimed. `untake` puts the work back, for a Slot that could not claim a block.
interface Work {
	readonly feature: ItemId;
	readonly run: (say: Say, portEnv?: PortEnv) => Promise<Ended>;
	readonly untake?: () => void;
}

const pauseOf = ({ why, resetsAt }: Pause): Pause => ({
	why,
	...(resetsAt === undefined ? {} : { resetsAt })
});

// A Feature that ended on a pause asks it of the run, even when its pull request was opened first.
const builtPause = (outcome: FeatureOutcome | null): { readonly paused?: Pause } => {
	if (outcome?.kind === 'paused') return { paused: pauseOf(outcome) };
	if (outcome?.kind === 'pull' && outcome.pause !== undefined) {
		return { paused: pauseOf(outcome.pause) };
	}
	return {};
};

const builtEnd = (feature: Named, outcome: FeatureOutcome | null): Ended => ({
	code: outcome === null || outcome.kind === 'paused' ? 1 : 0,
	...builtPause(outcome),
	built: { feature, outcome }
});

const fixEnd = (got: PullFixOutcome): Ended =>
	got.kind === 'skipped'
		? { code: null }
		: { code: pullFixExit(got), ...(got.kind === 'paused' ? { paused: pauseOf(got) } : {}) };

const CONFLICT_FIX_GOOD_ENDS: readonly ConflictFixOutcome['kind'][] = [
	'fixed',
	'gaveUp',
	'diverged'
];

// How a Slot's Conflict fix ended: one that left the draft alone did no work, so the Slot takes the next.
const conflictFixEnd = (got: ConflictFixOutcome): Ended => {
	if (got.kind === 'skipped') return { code: null };
	return {
		code: CONFLICT_FIX_GOOD_ENDS.includes(got.kind) ? 0 : 1,
		...(got.kind === 'paused' ? { paused: pauseOf(got) } : {})
	};
};

// Up to `slots` pieces of work at once, one per Slot and a Feature in one Slot at most. A free Slot takes, in order, the oldest conflicting draft (--watch only), the oldest red draft, the oldest Feature assigned to the person with the Go, then a Feedback round; it looks on each tick and whenever another Slot frees up. --once takes up to `slots` and returns when they end; 130 once stopped.
export async function queue(deps: QueueDeps, once: boolean): Promise<number> {
	const stop = deps.signal;
	const slots = Math.max(1, deps.slots ?? 1);
	const pollMs = deps.pollMs ?? POLL_MS;
	const waiting = waitingOnYou(deps);
	let told: string | null = null;
	// once per version; Nightjar never restarts itself
	const warnIfStale = async () => {
		const newer = await deps.newer?.();
		if (newer === undefined || newer === null || newer === told) return;
		told = newer;
		deps.say(
			`a newer Nightjar is available (${newer}); this run keeps the code it started with, restart it to use it`
		);
		deps.status.happened({ kind: 'stale', commit: newer });
		deps.status.codeMoved(newer);
	};
	// only with every Slot empty, so the newer-code check never runs beside a build
	const idle = async () => {
		await warnIfStale();
		const nextPollAt = new Date(deps.now().getTime() + pollMs).toISOString();
		deps.status.doing({ kind: 'idle', nextPollAt });
		await deps.sleep(pollMs, stop);
	};
	// Every Slot waits out one pause together: until the plan's reset time when the limit gave one still ahead, else PAUSE_MS.
	const pause = async ({ why: reason, resetsAt }: Pause) => {
		const now = deps.now().getTime();
		const reset = resetsAt === undefined ? 0 : resetsAt * 1000 - now;
		const ms = reset > 0 ? reset : PAUSE_MS;
		deps.status.doing({ kind: 'paused', why: reason, until: new Date(now + ms).toISOString() });
		await deps.sleep(ms, stop);
	};
	// the drafts the revisit passes took this run, at their head commit then; a draft a Conflict fix took is not fixed for its Pull checks at that same commit
	const tried = new Set<string>();
	// the pull requests a request for changes started a round on this run, by that request
	const asked = new Set<string>();
	// the pull requests Publish failed on this run
	const unpublished = new Set<number>();
	// the Features in a Slot, each with a promise that settles once its work ended and was told
	const running = new Map<ItemId, Promise<void>>();
	// the Queue last read, less the Features in a Slot
	let queued: Named[] = [];

	// The next piece of work in today's order, skipping the Features in a Slot, or null when none waits. A Tracker fault is thrown.
	const pick = async (): Promise<Work | null> => {
		const busy = new Set(running.keys());
		// --watch only: a conflicting draft is resolved before any red one, as its Pull checks may not run at all until it is
		const conflicts = deps.conflicts;
		if (!once && conflicts !== undefined) {
			const found = await findConflicting(deps, conflicts, tried, busy);
			if (found !== null) {
				return {
					feature: found.feature,
					run: async (say, portEnv) =>
						conflictFixEnd(await fixConflicting(deps, conflicts, tried, found, say, portEnv))
				};
			}
		}
		const pass = deps.pullChecks;
		if (pass !== undefined) {
			const red = await findRed(deps, pass, tried, busy);
			if (red !== null) {
				return {
					feature: red.feature,
					run: async (say, portEnv) => {
						const got = await fixRed(deps, pass, tried, red, say, portEnv);
						if (once && got.kind === 'paused') say(got.why);
						return fixEnd(got);
					}
				};
			}
		}
		// --watch only: a draft that is ready is published before the next Feature is taken, and on each idle tick
		if (!once && deps.publish !== undefined) {
			while ((await publishNext(deps, deps.publish, unpublished)) !== null) {
				// each ready draft, oldest first
			}
		}
		const features = (await deps.tracker.assignedFeatures(deps.person)).filter(
			(f) => !busy.has(f.id)
		);
		const next = features[0];
		// the Feature about to build is current, so it is not in the Queue; nothing refreshes it mid-build
		queued = features.slice(1).map(named);
		await waiting.read(queued);
		waiting.tell(queued);
		if (next !== undefined) {
			const feature = named(next);
			return {
				feature: feature.id,
				run: async (say, portEnv) =>
					builtEnd(
						feature,
						await buildOne({ ...deps, say }, feature, (f) => deps.build(f, say, portEnv))
					)
			};
		}
		// with no Feature with the Go, a trusted request for changes on one of Nightjar's pull requests is next
		const feedback = deps.feedback;
		const a = feedback === undefined ? null : await findAsked(deps, feedback, asked, busy);
		if (feedback === undefined || a === null) return null;
		return {
			feature: a.feature.id,
			// the request is taken once per run, so a Slot that finds no ports puts it back
			untake: () => asked.delete(askedKey(a)),
			run: async (say, portEnv) => {
				say(`#${a.feature.id}: ${a.request.author} asked for changes on ${a.open.pull.url}`);
				const answer = (f: Named) => feedback.answer(f, a.request.id, say, portEnv);
				return builtEnd(a.feature, await buildOne({ ...deps, say }, a.feature, answer));
			}
		};
	};

	// what the Slots' work changes as it ends: the pause under way, in which no Slot takes work, and a fault the run ends on once its Slots are empty
	const run: { pausing: Promise<void> | null; fault: { readonly error: unknown } | null } = {
		pausing: null,
		fault: null
	};
	// --once: the pieces of work taken, the exit code of those that ended, and whether it takes more
	let taken = 0;
	let code = 0;
	let takesMore = true;

	// the Features told why they paused on this run, so a retry after each pause does not comment each time
	const toldPaused = new Set<string>();
	const tellPaused = async (feature: ItemId, { why: reason }: Pause) => {
		const key = `${feature} ${reason}`;
		// a Tracker with a Status note says the pause there, as the build's note does
		if (deps.tracker.statusNote !== undefined || toldPaused.has(key)) return;
		toldPaused.add(key);
		try {
			await deps.tracker.comment(
				feature,
				`Nightjar paused: ${reason}.\n\nNothing to do. Nightjar tries this Feature again by itself when the pause ends, and the Go stays on it.${FOOTER}`
			);
		} catch {
			// the pause goes on without the comment
		}
	};

	const pauseAll = (why: Pause) => {
		if (run.pausing !== null) return;
		run.pausing = pause(why).then(() => {
			run.pausing = null;
		});
	};

	// the Features whose Slot found no block of ports, so the line saying why comes once, not on every tick
	const portless = new Set<ItemId>();
	// --once: whether a Slot found no block of ports, which ends a run that took nothing
	const blocked = { ports: false };

	const start = (work: Work, lease: PortLease | null) => {
		taken += 1;
		const say = slots > 1 ? slotSay(work.feature, deps.say) : deps.say;
		if (lease !== null) say(`ports ${lease.ports}`);
		// the block goes back once the work has ended, so the next work can claim it
		const ended = work
			.run(say, lease?.env)
			.then(async (end) => {
				running.delete(work.feature);
				deps.status.finished(work.feature);
				if (end.code === null) taken -= 1;
				else code = Math.max(code, end.code);
				if (end.paused !== undefined) {
					// --once ends on a pause; --watch pauses every Slot, the running ones finishing
					if (once) takesMore = false;
					else {
						await tellPaused(work.feature, end.paused);
						pauseAll(end.paused);
					}
				}
				if (end.built !== undefined) {
					const rest = queued.filter((f) => !running.has(f.id));
					waiting.tell(rest, end.built.outcome, end.built.feature);
				}
			})
			.catch((error: unknown) => {
				running.delete(work.feature);
				deps.status.finished(work.feature);
				run.fault ??= { error };
			})
			.finally(() => lease?.release());
		running.set(work.feature, ended);
	};

	// The block of ports for the work a Slot is about to take: null with no claim when the repo reserves none, and `false` with the work put back and a line saying why when no block is free.
	const claim = async (work: Work): Promise<PortLease | null | false> => {
		if (deps.claimPorts === undefined) return null;
		let lease: PortLease | null;
		try {
			lease = await deps.claimPorts();
		} catch (error) {
			work.untake?.();
			throw error;
		}
		if (lease !== null) {
			portless.delete(work.feature);
			return lease;
		}
		work.untake?.();
		blocked.ports = true;
		if (!portless.has(work.feature)) {
			portless.add(work.feature);
			deps.say(
				`#${work.feature} waits: no block of reserved ports is free; it starts once another Slot or run gives its block back (a lower ports.count in factory.json fits more blocks)`
			);
		}
		return false;
	};

	const mayTake = () =>
		running.size < slots &&
		stop?.aborted !== true &&
		run.fault === null &&
		run.pausing === null &&
		(!once || (takesMore && taken < slots));

	// Free Slots take work until none waits. A Tracker fault ends --once, and --watch says it and looks again on the next tick.
	const fill = async () => {
		while (mayTake()) {
			let work: Work | null;
			try {
				work = await pick();
			} catch (error) {
				if (once) run.fault = { error };
				else deps.say(why(error));
				return;
			}
			if (work === null) {
				if (once) takesMore = false;
				return;
			}
			let lease: PortLease | null | false;
			try {
				lease = await claim(work);
			} catch (error) {
				if (once) run.fault = { error };
				else deps.say(why(error));
				return;
			}
			// the Slot stays empty until the next tick, or until another Slot lets its block go
			if (lease === false) return;
			start(work, lease);
		}
	};

	for (;;) {
		await fill();
		const stopped = stop?.aborted === true;
		if (running.size === 0 && (run.pausing === null || stopped)) {
			if (stopped || once || run.fault !== null) break;
			await idle();
			continue;
		}
		const waits: Promise<void>[] = [...running.values()];
		if (run.pausing !== null) waits.push(run.pausing);
		// a free Slot looks again on the next tick, or as soon as another Slot frees up
		const tick = new AbortController();
		if (!once && mayTake()) {
			const signal = stop === undefined ? tick.signal : AbortSignal.any([stop, tick.signal]);
			waits.push(deps.sleep(pollMs, signal));
		}
		await Promise.race(waits);
		tick.abort();
	}
	if (run.fault !== null) throw run.fault.error;
	if (!once) return 130;
	if (taken > 0) return code;
	if (stop?.aborted === true) return 130;
	// the line saying why came when the Slot found no block; nothing was built
	if (blocked.ports) return 2;
	deps.say(none(deps));
	return 0;
}

// `nightjar <id>`: the Queue and Waiting on you read once, then the one Feature built, on the block of ports `portEnv` the caller claimed for it. A Tracker fault before the claim is thrown.
export async function buildNamed(
	deps: QueueDeps,
	id: ItemId,
	portEnv?: PortEnv
): Promise<FeatureOutcome | null> {
	const waiting = waitingOnYou(deps);
	const { title } = await deps.tracker.feature(id);
	const rest = (await deps.tracker.assignedFeatures(deps.person))
		.filter((f) => f.id !== id)
		.map(named);
	await waiting.read(rest);
	waiting.tell(rest);
	const outcome = await buildOne(deps, { id, title }, (f) => deps.build(f, deps.say, portEnv));
	deps.status.finished(id);
	waiting.tell(rest, outcome, { id, title });
	return outcome;
}

// doctor and init: the Features with the Go it would build, then those it would answer feedback on with no Go, when the Code host can list Nightjar's open pull requests.
export async function dryRun(
	deps: Pick<QueueDeps, 'tracker' | 'person' | 'say'> & {
		readonly codeHost?: CodeHost;
		// when factory.json sets `publish`: the drafts it would publish are listed too
		readonly publish?: PublishPass;
		readonly now?: () => Date;
	}
): Promise<void> {
	const features = await deps.tracker.assignedFeatures(deps.person);
	const pulls = deps.codeHost === undefined ? null : openPullsOf(deps.codeHost);
	const asked = pulls === null ? [] : await askedFeatures(deps, await pulls());
	const publishing = deps.publish === undefined ? [] : await publishable(deps, deps.publish);
	if (features.length === 0 && asked.length === 0 && publishing.length === 0) {
		deps.say(none(deps));
	}
	for (const f of features) {
		deps.say(`would build #${f.id} ${f.title}${f.lone === true ? ' (a lone issue)' : ''}`);
	}
	for (const a of asked) {
		const { id, title } = a.feature;
		if (!atLimit(a)) {
			deps.say(`would answer feedback on #${id} ${title}, on ${a.open.pull.url}`);
		} else if (!a.signals.includes('human')) {
			deps.say(`would hand #${id} ${title} to a person: ${limitWhy}`);
		}
	}
	for (const { draft, feature, title } of publishing) {
		deps.say(`would publish #${feature}${title === '' ? '' : ` ${title}`}, on ${draft.pull.url}`);
	}
}

// The drafts a Publish pass would take out of draft, oldest first, each with the Feature its body names and that Feature's title when the Tracker gives it.
async function publishable(
	deps: Pick<QueueDeps, 'tracker'> & { readonly now?: () => Date },
	pass: PublishPass
) {
	const found: { draft: NightjarDraft; feature: ItemId; title: string }[] = [];
	for (const draft of readyDrafts(await pass.drafts(), deps.now?.() ?? new Date())) {
		const feature = featureOfBody(draft.body);
		if (feature === undefined) continue;
		const title = await deps.tracker.feature(feature).then(
			(f) => f.title,
			() => ''
		);
		found.push({ draft, feature, title });
	}
	return found;
}
