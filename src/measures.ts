// The Measures of `nightjar ui`: how well the factory works over the last 30 days. A pure function of the ledger, the status file and what the Code host said of the pull requests; it reads and sends nothing.
import type { PullState } from './code-host.js';
import { spentFrom, type Spent } from './ledger.js';
import { hasTrailer } from './publish.js';
import type { Entry } from './spend.js';
import type { Event, Status } from './status-shape.js';

export const MEASURE_DAYS = 30;
const DAY_MS = 86_400_000;

// What the Code host said of each pull request, by its url; a pull request with no entry has not been read yet. Null when the Code host has no `pullState`.
export type PullStates = ReadonlyMap<string, PullState> | null;

// Autonomy: `share` is the fraction of the `merged` pull requests whose commits were all Nightjar's, `autonomous` of them. `none merged` is none of the pull requests read being merged; `not read` is none known merged while some are not read yet; `unavailable` is a Code host that cannot say which pull requests merged.
export type Autonomy =
	| {
			readonly kind: 'share';
			readonly share: number;
			readonly merged: number;
			readonly autonomous: number;
	  }
	| { readonly kind: 'none merged' }
	| { readonly kind: 'not read' }
	| { readonly kind: 'unavailable' };

export interface OutcomeCount {
	readonly outcome: string;
	readonly count: number;
}

export interface Measures {
	readonly days: number;
	// the pull requests Nightjar opened in the window
	readonly pulls: number;
	// Nightjar's merged pull requests whose commits are all Nightjar's, as a share
	readonly autonomy: Autonomy;
	// the median from the claim to the draft pull request; null with none to measure
	readonly timeToPullMs: number | null;
	// the median of what a pull request cost; null with none to measure
	readonly costPerPullUsd: number | null;
	// the Sessions recorded in the window, by how they ended, the most first
	readonly sessions: readonly OutcomeCount[];
}

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

type PullEvent = Extract<Event, { kind: 'pull' }>;
type Outcome = Extract<Event, { kind: 'pull' | 'failed' }>;

const isOutcome = (e: Event): e is Outcome => e.kind === 'pull' || e.kind === 'failed';

// A pull request Nightjar opened, as the status file's `pull` events tell it. A Feature built again on the same branch updates the same pull request, so each url is one.
export interface OpenedPull {
	readonly url: string;
	// when its first draft opened
	readonly at: number;
	// when the build behind it began; null in a file older than `startedAt`
	readonly startedAt: number | null;
	// the dollars its builds spent, from the ledger
	readonly costUsd: number;
}

// The pull requests the status file remembers, with what each cost: the Sessions of its Feature after the Feature's previous outcome, up to the draft, as the Completed list counts them. The status file keeps only its last ten events, so these reach back no further.
export function openedPulls(entries: readonly Entry[], status: Status | null): OpenedPull[] {
	const spent: readonly Spent[] = spentFrom(entries);
	const done = (status?.recent ?? []).filter(isOutcome);
	const byUrl = new Map<string, OpenedPull>();
	for (const [i, event] of done.entries()) {
		if (event.kind !== 'pull') continue;
		const before = done.slice(0, i).findLast((e) => e.feature === event.feature);
		const after = before === undefined ? null : Date.parse(before.at);
		const until = Date.parse(event.at);
		let costUsd = 0;
		for (const s of spent) {
			if (s.feature !== event.feature) continue;
			if ((after === null || s.at > after) && s.at <= until) costUsd += s.costUsd;
		}
		const known = byUrl.get(event.url);
		if (known !== undefined) {
			byUrl.set(event.url, { ...known, costUsd: known.costUsd + costUsd });
			continue;
		}
		byUrl.set(event.url, { url: event.url, at: until, startedAt: startOf(event), costUsd });
	}
	return [...byUrl.values()];
}

function startOf(event: PullEvent): number | null {
	const started = Date.parse(event.startedAt ?? '');
	return Number.isNaN(started) ? null : started;
}

// The pull requests opened in the last 30 days of `now`.
export function withinWindow(pulls: readonly OpenedPull[], now: Date): OpenedPull[] {
	const since = now.getTime() - MEASURE_DAYS * DAY_MS;
	return pulls.filter((p) => p.at > since && p.at <= now.getTime());
}

function autonomyOf(pulls: readonly OpenedPull[], states: PullStates): Autonomy {
	if (states === null) return { kind: 'unavailable' };
	let merged = 0;
	let autonomous = 0;
	let unread = 0;
	for (const pull of pulls) {
		const state = states.get(pull.url);
		if (state === undefined) {
			unread += 1;
			continue;
		}
		if (!state.merged) continue;
		merged += 1;
		// a commit of a person's is one without a `Factory-` trailer, so a merged pull request with even one counts against; none listed proves nothing
		if (state.commits.length > 0 && state.commits.every((c) => hasTrailer(c.message))) {
			autonomous += 1;
		}
	}
	if (merged === 0) return unread > 0 ? { kind: 'not read' } : { kind: 'none merged' };
	return { kind: 'share', share: autonomous / merged, merged, autonomous };
}

// How well the factory worked in the 30 days up to `now`.
export function measures(o: {
	readonly entries: readonly Entry[];
	readonly status: Status | null;
	readonly pullStates: PullStates;
	readonly now: Date;
}): Measures {
	const { entries, status, pullStates, now } = o;
	const pulls = withinWindow(openedPulls(entries, status), now);
	const since = now.getTime() - MEASURE_DAYS * DAY_MS;
	const counts = new Map<string, number>();
	for (const e of entries) {
		const at = Date.parse(e.at);
		if (at > since && at <= now.getTime()) {
			counts.set(e.outcome, (counts.get(e.outcome) ?? 0) + 1);
		}
	}
	const times: number[] = [];
	for (const p of pulls) {
		if (p.startedAt !== null) times.push(Math.max(0, p.at - p.startedAt));
	}
	return {
		days: MEASURE_DAYS,
		pulls: pulls.length,
		autonomy: autonomyOf(pulls, pullStates),
		timeToPullMs: median(times),
		costPerPullUsd: median(pulls.map((p) => p.costUsd)),
		sessions: [...counts]
			.map(([outcome, count]) => ({ outcome, count }))
			.sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome))
	};
}
