// --once, --watch, nightjar <id> and doctor: which Feature to build next, which red draft pull request the revisit pass fixes first, and what happens to a Feature whose build fails on a fault.
import {
	featureOfBody,
	handedOver,
	type FeatureOutcome,
	type PullFixOutcome,
	type RedDraft
} from './build.js';
import type { ChangeRequest, CodeHost, NightjarDraft, OpenPull } from './code-host.js';
import { AUTOMATIC_ROUNDS, feedbackHistory, newRequest } from './feedback-round.js';
import { FOOTER } from './footer.js';
import { featureStopStep, feedbackLimitStep, nextStepText } from './next-step.js';
import { NEEDS_A_PERSON, NEEDS_INFO } from './plan.js';
import { markPublished, readyToPublish } from './publish.js';
import type { Signal, SignalNames } from './signals.js';
import { BRANCH_PREFIX, branchFor } from './worktree.js';
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

import { DEFAULT_POLL_SECONDS } from './person-config.js';

export const POLL_MS = DEFAULT_POLL_SECONDS * 1000;
// how long --watch waits after a pause (the daily limit, the plan's usage limit) before it looks again
export const PAUSE_MS = 30 * 60_000;

export interface QueueDeps {
	readonly tracker: Tracker;
	// whose Features to build
	readonly person: string;
	readonly build: (feature: Named) => Promise<FeatureOutcome>;
	readonly status: StatusReport;
	readonly now: () => Date;
	readonly say: (line: string) => void;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly signal?: AbortSignal;
	// how long --watch waits when idle; POLL_MS when left out
	readonly pollMs?: number;
	// --watch only: newer Nightjar code than the one running, checked while idle
	readonly newer?: Newer;
	// factory.json's Signal names, for the Next step of a Feature handed back on a fault
	readonly signals?: SignalNames;
	// the revisit pass, when factory.json turns it on and the Code host can list Nightjar's drafts
	readonly pullChecks?: PullChecksPass;
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
	readonly answer: (feature: Named, asked: string) => Promise<FeatureOutcome>;
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
	readonly fix: (red: RedDraft) => Promise<PullFixOutcome>;
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

// Hands a Feature back to a person after a fault: the claim and the Go off, needs info on, the reason said.
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
	const next = deps.signals === undefined ? undefined : featureStopStep(deps.signals);
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
		const step = next === undefined ? '' : `\n\n${nextStepText(next)}`;
		await tracker.comment(id, `Nightjar stopped on a fault: ${reason}${step}${FOOTER}`);
	} catch {
		// the Tracker itself may be the fault
	}
}

// One Feature; a fault after the claim leaves it with the person, not stuck as being worked on.
export async function buildOne(
	deps: QueueDeps,
	feature: Named,
	build: QueueDeps['build'] = deps.build
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

// The oldest draft the revisit pass may take: its Pull checks done and one red, no person engaged, not handed to a person, its body naming a Feature assigned to the person that holds no Signal.
async function nextRedDraft(
	deps: QueueDeps,
	pass: PullChecksPass,
	tried: ReadonlySet<string>,
	// `nightjar <id>`: only this Feature's draft
	only?: ItemId
): Promise<RedDraft | null> {
	const drafts = [...(await pass.drafts())].sort((a, b) => a.pull.id - b.pull.id);
	for (const draft of drafts) {
		const { checks } = draft;
		if (checks.pending || checks.failed.length === 0 || draft.personEngaged) continue;
		if (tried.has(triedKey(draft))) continue;
		// handed to a person once, it stays theirs when they take needs a person off
		if (handedOver(draft.body)) continue;
		const feature = featureOfBody(draft.body);
		if (feature === undefined || (only !== undefined && feature !== only)) continue;
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

// One red draft's Pull-check fix round, or null when none waits; a fault is said, and the Queue goes on.
async function revisit(
	deps: QueueDeps,
	pass: PullChecksPass,
	tried: Set<string>,
	only?: ItemId
): Promise<PullFixOutcome | null> {
	let red: RedDraft | null;
	try {
		red = await nextRedDraft(deps, pass, tried, only);
	} catch (fault) {
		deps.say(`could not read Nightjar's draft pull requests: ${why(fault)}`);
		return null;
	}
	if (red === null) return null;
	try {
		const got = await pass.fix(red);
		// the day's limit holds it back, so it is taken once the day is over
		if (got.kind !== 'paused') tried.add(triedKey(red.draft));
		return got;
	} catch (fault) {
		tried.add(triedKey(red.draft));
		const reason = why(fault);
		deps.say(`the Pull-check fix of ${red.draft.pull.url} stopped on a fault: ${reason}`);
		return { kind: 'skipped', why: reason };
	}
}

// Whether a round did a piece of work; a skipped one left the pull request alone, so the Queue's next work is still due.
const didWork = (got: PullFixOutcome | null): got is PullFixOutcome =>
	got !== null && got.kind !== 'skipped';

// The exit code of a run that ended on a Pull-check fix round: a fix pushed, or the Feature handed to a person, is a good end.
const GOOD_ENDS: readonly PullFixOutcome['kind'][] = ['fixed', 'gaveUp', 'atLimit', 'diverged'];

export function pullFixExit(got: PullFixOutcome): number {
	return GOOD_ENDS.includes(got.kind) ? 0 : 1;
}

// `nightjar <id>`: the Feature's red draft fixed, or null when the pass is off or that Feature has none to fix, so the Feature is built as today.
export async function fixNamed(deps: QueueDeps, id: ItemId): Promise<PullFixOutcome | null> {
	const pass = deps.pullChecks;
	if (pass === undefined) return null;
	const got = await revisit(deps, pass, new Set(), id);
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

const limitWhy = `its pull request has had its ${String(AUTOMATIC_ROUNDS)} automatic Feedback rounds`;

// A request for changes past the limit starts no round: the Feature gets needs a person and a comment saying why, once; a Feature that carries needs a person already is left alone.
async function feedbackLimit(deps: QueueDeps, a: AskedFeature): Promise<void> {
	const { id } = a.feature;
	const { author } = a.request;
	const { url } = a.open.pull;
	if (a.signals.includes('human')) return;
	deps.say(`#${id}: ${author} asked for changes on ${url}, and ${limitWhy}; handed to a person`);
	const next = deps.signals === undefined ? null : feedbackLimitStep(deps.signals);
	const step = next === null ? '' : `\n\n${nextStepText(next)}`;
	try {
		await deps.tracker.addSignal(id, 'human');
		await deps.tracker.comment(
			id,
			`Nightjar did not answer the changes ${author} asked for on ${url}: ${limitWhy}, and only a Go starts another.${step}${FOOTER}`
		);
	} catch (fault) {
		deps.say(`could not hand #${id} to a person: ${why(fault)}`);
	}
}

// One Feedback round a trusted request for changes started, or null when none waits. A pull request is taken once per request in a run, so a round that lands no commit is not started again and again.
async function answerAsked(
	deps: QueueDeps,
	pass: FeedbackPass,
	tried: Set<string>
): Promise<{ readonly feature: Named; readonly outcome: FeatureOutcome | null } | null> {
	let found: AskedFeature[];
	try {
		found = await askedFeatures(deps, await pass.pulls());
	} catch (fault) {
		deps.say(`could not read Nightjar's open pull requests: ${why(fault)}`);
		return null;
	}
	for (const a of found) {
		const key = `${String(a.open.pull.id)} ${a.request.id}`;
		if (tried.has(key)) continue;
		if (atLimit(a)) {
			await feedbackLimit(deps, a);
			continue;
		}
		tried.add(key);
		deps.say(`#${a.feature.id}: ${a.request.author} asked for changes on ${a.open.pull.url}`);
		const outcome = await buildOne(deps, a.feature, (f) => pass.answer(f, a.request.id));
		return { feature: a.feature, outcome };
	}
	return null;
}

const none = (deps: Pick<QueueDeps, 'person'>) =>
	`no Feature with the Go is assigned to ${deps.person}`;

// The oldest Feature assigned to the person with the Go, then the next; 130 once stopped.
export async function queue(deps: QueueDeps, once: boolean): Promise<number> {
	const stop = deps.signal;
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
	const idle = async () => {
		await warnIfStale();
		const pollMs = deps.pollMs ?? POLL_MS;
		const nextPollAt = new Date(deps.now().getTime() + pollMs).toISOString();
		deps.status.doing({ kind: 'idle', nextPollAt });
		await deps.sleep(pollMs, stop);
	};
	// the Features told why they paused on this run, so a retry every PAUSE_MS does not comment each time
	const toldPaused = new Set<string>();
	// Why a piece of work paused the run: a build that stopped before its pull request, or one that opened it and then paused.
	const pausedBy = (outcome: FeatureOutcome | null) =>
		outcome?.kind === 'paused'
			? outcome.why
			: outcome?.kind === 'pull'
				? outcome.paused
				: undefined;
	const pauseFor = async (feature: Named, reason: string) => {
		const key = `${feature.id} ${reason}`;
		if (!toldPaused.has(key)) {
			toldPaused.add(key);
			try {
				await deps.tracker.comment(
					feature.id,
					`Nightjar paused: ${reason}.\n\nNothing to do. Nightjar tries this Feature again in ${String(PAUSE_MS / 60_000)} minutes, and the Go stays on it.${FOOTER}`
				);
			} catch {
				// the pause goes on without the comment
			}
		}
		await pause(reason);
	};
	const pause = async (reason: string) => {
		const until = new Date(deps.now().getTime() + PAUSE_MS).toISOString();
		deps.status.doing({ kind: 'paused', why: reason, until });
		await deps.sleep(PAUSE_MS, stop);
	};
	// the drafts the revisit pass took this run, at their head commit then
	const tried = new Set<string>();
	// the pull requests a request for changes started a round on this run, by that request
	const asked = new Set<string>();
	// the pull requests Publish failed on this run
	const unpublished = new Set<number>();
	while (stop?.aborted !== true) {
		// a red draft is revisited before the next Feature is taken, and on each idle tick in --watch
		const pass = deps.pullChecks;
		if (pass !== undefined) {
			const got = await revisit(deps, pass, tried);
			if (once) {
				// --once is one piece of work: the oldest red draft, else the next Feature
				if (got?.kind === 'paused') deps.say(got.why);
				if (didWork(got)) return pullFixExit(got);
			} else {
				if (got?.kind === 'paused') await pause(got.why);
				if (got !== null) continue;
			}
		}
		// --watch only: a draft that is ready is published before the next Feature is taken, and on each idle tick
		if (!once && deps.publish !== undefined) {
			if ((await publishNext(deps, deps.publish, unpublished)) !== null) continue;
		}
		let features;
		try {
			features = await deps.tracker.assignedFeatures(deps.person);
		} catch (fault) {
			if (once) throw fault;
			deps.say(why(fault));
			await idle();
			continue;
		}
		const next = features[0];
		// the Feature about to build is current, so it is not in the Queue; nothing refreshes it mid-build
		const rest = features.slice(1).map(named);
		await waiting.read(rest);
		waiting.tell(rest);
		if (next === undefined) {
			// with no Feature with the Go, a trusted request for changes on one of Nightjar's pull requests is next
			const answered =
				deps.feedback === undefined ? null : await answerAsked(deps, deps.feedback, asked);
			if (answered !== null) {
				const { outcome } = answered;
				waiting.tell(rest, outcome, answered.feature);
				if (once) return outcome === null || outcome.kind === 'paused' ? 1 : 0;
				const reason = pausedBy(outcome);
				if (reason !== undefined) await pauseFor(answered.feature, reason);
				continue;
			}
		}
		if (next === undefined && once) {
			deps.say(none(deps));
			return 0;
		}
		if (next === undefined) {
			await idle();
			continue;
		}
		const outcome = await buildOne(deps, named(next));
		waiting.tell(rest, outcome, next);
		if (once) return outcome === null || outcome.kind === 'paused' ? 1 : 0;
		const paused = pausedBy(outcome);
		if (paused !== undefined) await pauseFor(named(next), paused);
	}
	return 130;
}

// `nightjar <id>`: the Queue and Waiting on you read once, then the one Feature built. A Tracker fault before the claim is thrown.
export async function buildNamed(deps: QueueDeps, id: ItemId): Promise<FeatureOutcome | null> {
	const waiting = waitingOnYou(deps);
	const { title } = await deps.tracker.feature(id);
	const rest = (await deps.tracker.assignedFeatures(deps.person))
		.filter((f) => f.id !== id)
		.map(named);
	await waiting.read(rest);
	waiting.tell(rest);
	const outcome = await buildOne(deps, { id, title });
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
