// --once, --watch, nightjar <id> and doctor: which Feature to build next, which red draft pull request the revisit pass fixes first, and what happens to a Feature whose build fails on a fault.
import {
	FOOTER,
	featureOfBody,
	type FeatureOutcome,
	type PullFixOutcome,
	type RedDraft
} from './build.js';
import type { CodeHost, NightjarDraft } from './code-host.js';
import { NEEDS_A_PERSON, NEEDS_INFO } from './plan.js';
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

export const POLL_MS = 2 * 60_000;
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
	// --watch only: newer Nightjar code than the one running, checked while idle
	readonly newer?: Newer;
	// the revisit pass, when factory.json turns it on and the Code host can list Nightjar's drafts
	readonly pullChecks?: PullChecksPass;
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

// Hands a Feature back to a person after a fault: the claim off, needs info on, the reason said.
export async function handBack(
	deps: QueueDeps,
	feature: Named,
	fault: unknown,
	startedAt?: string
): Promise<void> {
	const { tracker } = deps;
	const { id, title } = feature;
	const reason = why(fault);
	deps.say(`#${id} failed: ${reason}`);
	deps.status.happened({
		kind: 'failed',
		feature: id,
		title,
		why: reason,
		...(startedAt === undefined ? {} : { startedAt })
	});
	try {
		await tracker.removeSignal(id, 'working');
		await tracker.addSignal(id, 'needsInfo');
		await tracker.comment(id, `Nightjar stopped on a fault: ${reason}${FOOTER}`);
	} catch {
		// the Tracker itself may be the fault
	}
}

// One Feature; a fault after the claim leaves it with the person, not stuck as being worked on.
export async function buildOne(deps: QueueDeps, feature: Named): Promise<FeatureOutcome | null> {
	const startedAt = deps.now().toISOString();
	try {
		return await deps.build(feature);
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

// The oldest draft the revisit pass may take: its Pull checks done and one red, no person engaged, its body naming a Feature assigned to the person that holds no Signal.
async function nextRedDraft(
	deps: QueueDeps,
	pass: PullChecksPass,
	tried: ReadonlySet<string>
): Promise<RedDraft | null> {
	const drafts = [...(await pass.drafts())].sort((a, b) => a.pull.id - b.pull.id);
	for (const draft of drafts) {
		const { checks } = draft;
		if (checks.pending || checks.failed.length === 0 || draft.personEngaged) continue;
		if (tried.has(triedKey(draft))) continue;
		const feature = featureOfBody(draft.body);
		if (feature === undefined) continue;
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
	tried: Set<string>
): Promise<PullFixOutcome | null> {
	let red: RedDraft | null;
	try {
		red = await nextRedDraft(deps, pass, tried);
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
		const nextPollAt = new Date(deps.now().getTime() + POLL_MS).toISOString();
		deps.status.doing({ kind: 'idle', nextPollAt });
		await deps.sleep(POLL_MS, stop);
	};
	const pause = async (reason: string) => {
		const until = new Date(deps.now().getTime() + PAUSE_MS).toISOString();
		deps.status.doing({ kind: 'paused', why: reason, until });
		await deps.sleep(PAUSE_MS, stop);
	};
	// the drafts the revisit pass took this run, at their head commit then
	const tried = new Set<string>();
	while (stop?.aborted !== true) {
		// --watch revisits a red draft before it takes the next Feature, and on each idle tick
		const pass = once ? undefined : deps.pullChecks;
		if (pass !== undefined) {
			const got = await revisit(deps, pass, tried);
			if (got?.kind === 'paused') await pause(got.why);
			if (got !== null) continue;
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
		if (outcome?.kind === 'paused') await pause(outcome.why);
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

export async function dryRun(deps: Pick<QueueDeps, 'tracker' | 'person' | 'say'>): Promise<void> {
	const features = await deps.tracker.assignedFeatures(deps.person);
	if (features.length === 0) deps.say(none(deps));
	for (const f of features) deps.say(`would build #${f.id} ${f.title}`);
}
