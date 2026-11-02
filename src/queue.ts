// --once, --watch, nightjar <id> and doctor: which Feature to build next, and what happens to one whose build fails on a fault.
import { FOOTER, type FeatureOutcome } from './build.js';
import { needsAPerson } from './plan.js';
import type { StatusReport, WaitingItem } from './status.js';
import type { ItemId, Tracker } from './tracker.js';
import { why } from './say.js';

export const POLL_MS = 2 * 60_000;
// how long --watch waits after a pause (the daily limit, the plan's usage limit) before it looks again
export const PAUSE_MS = 30 * 60_000;

export interface QueueDeps {
	readonly tracker: Tracker;
	// whose Features to build
	readonly person: string;
	readonly build: (id: ItemId) => Promise<FeatureOutcome>;
	readonly status: StatusReport;
	readonly now: () => Date;
	readonly say: (line: string) => void;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly signal?: AbortSignal;
}

// Hands a Feature back to a person after a fault: the claim off, needs info on, the reason said.
export async function handBack(
	deps: QueueDeps,
	id: ItemId,
	fault: unknown,
	title?: string
): Promise<void> {
	const { tracker } = deps;
	const reason = why(fault);
	deps.say(`#${id} failed: ${reason}`);
	deps.status.happened({
		kind: 'failed',
		feature: id,
		...(title === undefined ? {} : { title }),
		why: reason
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
export async function buildOne(
	deps: QueueDeps,
	id: ItemId,
	title?: string
): Promise<FeatureOutcome | null> {
	try {
		return await deps.build(id);
	} catch (fault) {
		await handBack(deps, id, fault, title);
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
		const items: WaitingItem[] = [];
		for (const f of (await deps.tracker.waitingOn?.(deps.person)) ?? []) {
			const { signals } = await deps.tracker.standing(f.id);
			items.push({
				kind: 'feature',
				id: f.id,
				title: f.title,
				why: signals.includes('needsInfo') ? 'needs info' : 'needs a person'
			});
		}
		return items;
	} catch (fault) {
		deps.say(`could not read what waits on ${deps.person}: ${why(fault)}`);
		return previous;
	}
}

const none = (deps: Pick<QueueDeps, 'person'>) =>
	`no Feature with the Go is assigned to ${deps.person}`;

// The oldest Feature assigned to the person with the Go, then the next; 130 once stopped.
export async function queue(deps: QueueDeps, once: boolean): Promise<number> {
	const stop = deps.signal;
	// the last Feature's Tickets that wait for a person
	let waitingOnYou: WaitingItem[] = [];
	// the Features that wait for a person, when the Tracker can list them
	let waitingFeatures: WaitingItem[] = [];
	const idle = async () => {
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
		const next = features[0];
		const canList = deps.tracker.waitingOn !== undefined;
		if (canList) waitingFeatures = await readWaitingFeatures(deps, waitingFeatures);
		// the Feature about to build is current, so it is not in the Queue; nothing refreshes it mid-build
		const waiting = () => ({
			items: [...waitingFeatures, ...waitingOnYou],
			trackerCannotList: !canList
		});
		const rest = features.slice(1).map((f) => ({ id: f.id, title: f.title }));
		deps.status.refreshed(rest, waiting());
		if (next === undefined && once) {
			deps.say(none(deps));
			return 0;
		}
		if (next === undefined) {
			await idle();
			continue;
		}
		const outcome = await buildOne(deps, next.id, next.title);
		// only a Feature that ended well says what its Tickets wait for; after a fault or a pause the old answer is stale
		waitingOnYou =
			outcome?.kind === 'pull' || outcome?.kind === 'nothing'
				? outcome.waiting.filter(needsAPerson).map((w) => ({
						kind: 'ticket',
						id: w.id,
						title: w.title,
						why: w.why
					}))
				: [];
		deps.status.refreshed(rest, waiting());
		if (once) return outcome === null || outcome.kind === 'paused' ? 1 : 0;
		if (outcome?.kind === 'paused') {
			const until = new Date(deps.now().getTime() + PAUSE_MS).toISOString();
			deps.status.doing({ kind: 'paused', why: outcome.why, until });
			await deps.sleep(PAUSE_MS, stop);
		}
	}
	return 130;
}

export async function dryRun(deps: Pick<QueueDeps, 'tracker' | 'person' | 'say'>): Promise<void> {
	const features = await deps.tracker.assignedFeatures(deps.person);
	if (features.length === 0) deps.say(none(deps));
	for (const f of features) deps.say(`would build #${f.id} ${f.title}`);
}
