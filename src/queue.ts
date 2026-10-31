// --once, --watch and --dry-run: which Feature to build next, from the Tracker, and what happens
// to a Feature whose build fails on a fault.
import { FOOTER, type FeatureOutcome } from './build.js';
import type { StatusReport } from './status.js';
import type { ItemId, Tracker } from './tracker.js';

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

export const why = (fault: unknown) => (fault instanceof Error ? fault.message : String(fault));

// Hands a Feature back to a person after a fault: the claim off, needs info on, the reason said.
export async function handBack(deps: QueueDeps, id: ItemId, fault: unknown): Promise<void> {
	const { tracker } = deps;
	const reason = why(fault);
	deps.say(`#${id} failed: ${reason}`);
	deps.status.happened({ kind: 'failed', feature: id, why: reason });
	try {
		await tracker.removeSignal(id, 'working');
		await tracker.addSignal(id, 'needsInfo');
		await tracker.comment(id, `Nightjar stopped on a fault: ${reason}${FOOTER}`);
	} catch {
		// the Tracker itself may be the fault
	}
}

// One Feature; a fault after the claim leaves it with the person, not stuck as being worked on.
export async function buildOne(deps: QueueDeps, id: ItemId): Promise<FeatureOutcome | null> {
	try {
		return await deps.build(id);
	} catch (fault) {
		await handBack(deps, id, fault);
		return null;
	}
}

const none = (deps: Pick<QueueDeps, 'person'>) =>
	`no Feature with the Go is assigned to ${deps.person}`;

// The oldest Feature assigned to the person with the Go, then the next; 130 once stopped.
export async function queue(deps: QueueDeps, once: boolean): Promise<number> {
	const stop = deps.signal;
	const idle = async () => {
		const nextPollAt = new Date(deps.now().getTime() + POLL_MS).toISOString();
		deps.status.doing({ kind: 'idle', nextPollAt });
		await deps.sleep(POLL_MS, stop);
	};
	while (stop?.aborted !== true) {
		let next;
		try {
			next = (await deps.tracker.assignedFeatures(deps.person))[0];
		} catch (fault) {
			if (once) throw fault;
			deps.say(why(fault));
			await idle();
			continue;
		}
		if (next === undefined && once) {
			deps.say(none(deps));
			return 0;
		}
		if (next === undefined) {
			await idle();
			continue;
		}
		const outcome = await buildOne(deps, next.id);
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
