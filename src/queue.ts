// --once, --watch, nightjar <id> and doctor: which Feature to build next, and what happens to one whose build fails on a fault.
import type { FeatureOutcome, Start } from './build.js';
import type { CodeHost, OpenPull } from './code-host.js';
import { FOOTER } from './footer.js';
import { NEEDS_A_PERSON, NEEDS_INFO } from './plan.js';
import type { Signal } from './signals.js';
import { waitingTickets, type Named, type StatusReport, type WaitingItem } from './status.js';
import type { Feature, ItemId, Tracker } from './tracker.js';
import { why } from './say.js';
import type { Newer } from './stale.js';
import type { Env } from './git.js';
import { BRANCH_PREFIX, branchFor, feedbackCommits, type FeedbackCommit } from './worktree.js';

export const POLL_MS = 2 * 60_000;
// how long --watch waits after a pause (the daily limit, the plan's usage limit) before it looks again
export const PAUSE_MS = 30 * 60_000;

// The most Feedback rounds requests for changes start on one pull request; after them only the Go starts one.
export const AUTOMATIC_ROUNDS = 5;

// What --once and --watch read to start a Feedback round on a trusted request for changes.
export interface PullWatch {
	readonly codeHost: CodeHost;
	// the commits of the Feedback rounds on a branch, as its trailers name them
	readonly feedbackCommits: (branch: string) => Promise<FeedbackCommit[]>;
}

// The branches read in the main checkout, against the base the Features are built on.
export const pullWatch = (
	codeHost: CodeHost,
	root: string,
	baseBranch: string,
	env: Env
): PullWatch => ({
	codeHost,
	feedbackCommits: (branch) => feedbackCommits(root, branch, baseBranch, env)
});

export interface QueueDeps {
	readonly tracker: Tracker;
	// whose Features to build
	readonly person: string;
	readonly build: (feature: Named, start?: Start) => Promise<FeatureOutcome>;
	// without it only the Go starts a build
	readonly pulls?: PullWatch;
	readonly status: StatusReport;
	readonly now: () => Date;
	readonly say: (line: string) => void;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly signal?: AbortSignal;
	// --watch only: newer Nightjar code than the one running, checked while idle
	readonly newer?: Newer;
}

// Hands a Feature back to a person after a fault: the claim off, needs info on, the reason said.
export async function handBack(deps: QueueDeps, feature: Named, fault: unknown): Promise<void> {
	const { tracker } = deps;
	const { id, title } = feature;
	const reason = why(fault);
	deps.say(`#${id} failed: ${reason}`);
	deps.status.happened({ kind: 'failed', feature: id, title, why: reason });
	try {
		await tracker.removeSignal(id, 'working');
		await tracker.addSignal(id, 'needsInfo');
		await tracker.comment(id, `Nightjar stopped on a fault: ${reason}${FOOTER}`);
	} catch {
		// the Tracker itself may be the fault
	}
}

// One Feature; a fault after the claim leaves it with the person, not stuck as being worked on.
export async function buildOne(
	deps: QueueDeps,
	feature: Named,
	start: Start = 'go'
): Promise<FeatureOutcome | null> {
	try {
		return await deps.build(feature, start);
	} catch (fault) {
		await handBack(deps, feature, fault);
		return null;
	}
}

const samePerson = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Why `nightjar <id>` may not claim this Feature, or null when it may. Working comes first: a claim takes the Go off.
export async function cannotClaim(
	deps: Pick<QueueDeps, 'tracker' | 'person'>,
	id: ItemId
): Promise<string | null> {
	const { assignees, signals } = await deps.tracker.standing(id);
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
	return {
		read: async () => {
			if (canList) features = await readWaitingFeatures(deps, features);
		},
		// `tickets` are the current Feature's, which only a Feature that ended well says
		tell: (queue: Named[], outcome: FeatureOutcome | null = null) => {
			const tickets =
				outcome?.kind === 'pull' || outcome?.kind === 'nothing'
					? waitingTickets(outcome.waiting)
					: [];
			deps.status.refreshed(queue, {
				items: [...features, ...tickets],
				trackerCannotList: !canList
			});
		}
	};
}

const named = ({ id, title }: Named): Named => ({ id, title });

const none = (deps: Pick<QueueDeps, 'person'>) =>
	`no Feature with the Go is assigned to ${deps.person}`;

// A Feature whose open pull request a trusted reviewer asked changes of since its last Feedback round.
export interface AskedForChanges {
	readonly feature: Named;
	readonly pull: OpenPull;
	// the rounds requests for changes started on the pull request already
	readonly rounds: number;
}

// Any of them keeps a request for changes from starting a round: the Go starts a build of its own, and the rest wait on a run or a person.
const HELD: readonly Signal[] = ['go', 'working', 'needsInfo', 'human'];

const time = (at: string) => Date.parse(at);

// The Feature a branch of Nightjar's was made for: the first id at the branch's start the Tracker knows decides, and none when its title has moved its branch since.
async function featureOf(tracker: Tracker, branch: string): Promise<Named | null> {
	const parts = branch.slice(BRANCH_PREFIX.length).split('-');
	for (let n = 1; n <= parts.length; n += 1) {
		let feature: Feature;
		try {
			feature = await tracker.feature(parts.slice(0, n).join('-'));
		} catch {
			// an id the Tracker does not know, as PROJ is when the Feature is PROJ-1
			continue;
		}
		return branchFor(feature.id, feature.title) === branch ? named(feature) : null;
	}
	return null;
}

// The pull request's Feature, when the person's, held by no Signal, and asked changes of by a trusted reviewer after the pull request's last Feedback round.
async function askedOn(
	deps: Pick<QueueDeps, 'tracker' | 'person'>,
	watch: PullWatch,
	pull: OpenPull
): Promise<AskedForChanges | null> {
	const feature = await featureOf(deps.tracker, pull.branch);
	if (feature === null) return null;
	const { assignees, signals } = await deps.tracker.standing(feature.id);
	if (!assignees.some((a) => samePerson(a, deps.person))) return null;
	if (signals.some((s) => HELD.includes(s))) return null;
	const commits = await watch.feedbackCommits(pull.branch);
	// the rounds of this pull request, not of one the branch had before it
	const ofPull = commits.filter((c) => time(c.at) >= time(pull.openedAt));
	const since = Math.max(time(pull.openedAt), ...ofPull.map((c) => time(c.at)));
	if (!pull.changesRequested.some((r) => r.trusted && time(r.at) > since)) return null;
	const rounds = ofPull.filter((c) => c.automatic).length;
	if (rounds < AUTOMATIC_ROUNDS) {
		// a round with nothing to answer would only run the review again, at every poll
		const answered = new Set(commits.flatMap((c) => c.ids));
		const feedback = (await watch.codeHost.feedback?.(pull)) ?? [];
		if (!feedback.some((f) => f.trusted && !answered.has(f.id))) return null;
	}
	return { feature, pull, rounds };
}

// Every Feature a trusted request for changes waits on, the ones past their automatic rounds too; none from a Code host without openPulls, feedback and reply. A pull request that cannot be read is said and skipped.
export async function askedForChanges(
	deps: Pick<QueueDeps, 'tracker' | 'person' | 'pulls' | 'say'>
): Promise<AskedForChanges[]> {
	const watch = deps.pulls;
	const host = watch?.codeHost;
	if (watch === undefined || host?.openPulls === undefined) return [];
	if (host.feedback === undefined || host.reply === undefined) return [];
	const found: AskedForChanges[] = [];
	for (const pull of await host.openPulls(BRANCH_PREFIX)) {
		try {
			const asked = await askedOn(deps, watch, pull);
			if (asked !== null) found.push(asked);
		} catch (fault) {
			deps.say(`could not read the requests for changes on ${pull.url}: ${why(fault)}`);
		}
	}
	return found;
}

const pastRounds = `${String(AUTOMATIC_ROUNDS)} automatic Feedback rounds`;

// A request for changes after the last automatic round hands the Feature to a person; only the Go starts another round.
async function handOver(deps: QueueDeps, asked: AskedForChanges): Promise<void> {
	const { id, title } = asked.feature;
	const reason = `its pull request had ${pastRounds}`;
	deps.say(`#${id} ${title}: ${reason}, so it needs a person`);
	deps.status.happened({ kind: 'needs-info', feature: id, ticket: null, why: reason });
	await deps.tracker.addSignal(id, 'human');
	await deps.tracker.comment(
		id,
		`A trusted reviewer asked for changes on ${asked.pull.url} again, after the ${pastRounds} Nightjar runs on one pull request without the Go, so this Feature needs a person. Give it the Go to have Nightjar answer the feedback in one more round.${FOOTER}`
	);
}

// The first Feature a trusted request for changes waits on, the ones past their automatic rounds handed to a person on the way; a Code host that cannot be read is said, and gives none.
async function nextAsked(deps: QueueDeps): Promise<Named | null> {
	let all: AskedForChanges[];
	try {
		all = await askedForChanges(deps);
	} catch (fault) {
		deps.say(`could not read the open pull requests: ${why(fault)}`);
		return null;
	}
	for (const asked of all) {
		if (asked.rounds < AUTOMATIC_ROUNDS) return asked.feature;
		try {
			await handOver(deps, asked);
		} catch (fault) {
			deps.say(`could not hand #${asked.feature.id} to a person: ${why(fault)}`);
		}
	}
	return null;
}

// The oldest Feature assigned to the person with the Go, then the next, then one a trusted request for changes waits on; 130 once stopped.
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
		const nextPollAt = new Date(deps.now().getTime() + POLL_MS).toISOString();
		deps.status.doing({ kind: 'idle', nextPollAt });
		await deps.sleep(POLL_MS, stop);
	};
	while (stop?.aborted !== true) {
		let features;
		try {
			features = await deps.tracker.assignedFeatures(deps.person);
		} catch (fault) {
			if (once) throw fault;
			deps.say(why(fault));
			await idle();
			continue;
		}
		const first = features[0];
		await waiting.read();
		// the Feature about to build is current, so it is not in the Queue; nothing refreshes it mid-build
		const rest = features.slice(1).map(named);
		waiting.tell(rest);
		// the Features with the Go come first
		const go = first === undefined ? null : named(first);
		const next = go ?? (await nextAsked(deps));
		if (next === null && once) {
			deps.say(none(deps));
			return 0;
		}
		if (next === null) {
			await idle();
			continue;
		}
		const outcome = await buildOne(deps, next, go === null ? 'changesRequested' : 'go');
		waiting.tell(rest, outcome);
		if (once) return outcome === null || outcome.kind === 'paused' ? 1 : 0;
		if (outcome?.kind === 'paused') {
			const until = new Date(deps.now().getTime() + PAUSE_MS).toISOString();
			deps.status.doing({ kind: 'paused', why: outcome.why, until });
			await deps.sleep(PAUSE_MS, stop);
		}
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
	await waiting.read();
	waiting.tell(rest);
	const outcome = await buildOne(deps, { id, title });
	waiting.tell(rest, outcome);
	return outcome;
}

// What --once and --watch would take, in their order, changing nothing.
export async function dryRun(
	deps: Pick<QueueDeps, 'tracker' | 'person' | 'say' | 'pulls'>
): Promise<void> {
	const features = await deps.tracker.assignedFeatures(deps.person);
	const asked = await askedForChanges(deps);
	if (features.length === 0 && asked.length === 0) deps.say(none(deps));
	for (const f of features) deps.say(`would build #${f.id} ${f.title}`);
	for (const { feature, pull, rounds } of asked) {
		const which = `#${feature.id} ${feature.title}`;
		deps.say(
			rounds < AUTOMATIC_ROUNDS
				? `would answer feedback on ${which}, asked for changes on ${pull.url}`
				: `would hand ${which} to a person: ${pull.url} had ${pastRounds}`
		);
	}
}
