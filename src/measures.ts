// The Measures of `nightjar ui`: how well the factory works over the last 30 days. A pure function of the ledger, the Logbooks and what the Code host said of the pull requests; it reads and sends nothing.
import type { PullState } from './code-host.js';
import { spentFrom, type Spent } from './ledger.js';
import type { LogbookEntry } from './logbook.js';
import { hasTrailer } from './publish.js';
import type { Entry } from './spend.js';
import type { ItemId } from './tracker.js';

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

// How a Session ended, in a few kinds: a ledger outcome carries free text (`failed: ${why}`, `paused: ${why}`, `round 3`), so counting it as written would make each failure its own row. `done` is any other end: built, a verdict, a round that fixed, a proposal.
export type OutcomeKind = 'done' | 'failed' | 'paused' | 'stopped' | 'questions' | 'gave up';

export function outcomeKind(e: Pick<Entry, 'outcome' | 'failure'>): OutcomeKind {
	const o = e.outcome;
	if (o.includes('stopped by a person')) return 'stopped';
	if (/(^|: )paused: /.test(o)) return 'paused';
	if (e.failure !== undefined || /\bfailed\b/.test(o)) return 'failed';
	if (/^questions\b/.test(o)) return 'questions';
	if (/\bgave up\b|\bblocked\b/.test(o)) return 'gave up';
	return 'done';
}

export interface OutcomeCount {
	readonly outcome: OutcomeKind;
	readonly count: number;
}

export interface Measures {
	readonly days: number;
	// the pull requests Nightjar opened in the window, as the Logbooks record them
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

// A pull request Nightjar opened, as its Feature's Logbook tells it. A Feature built again on the same branch updates the same pull request, so each url is one.
export interface OpenedPull {
	readonly url: string;
	// when its first draft opened
	readonly at: number;
	// when the build behind it began, its claim; null when the Logbook has no start before the draft
	readonly startedAt: number | null;
	// the dollars its builds spent, from the ledger
	readonly costUsd: number;
}

// Every Logbook, by its Feature: what `everyLogbook` reads.
export type Logbooks = ReadonlyMap<ItemId, readonly LogbookEntry[]>;

const timeOf = (at: string): number | null => {
	const t = Date.parse(at);
	return Number.isNaN(t) ? null : t;
};

// The pull requests the Logbooks record, with what each cost: the Sessions of its Feature after the build began, up to the draft, and the Sessions after the draft (Feedback rounds, Review rounds, Pull-check fixes) up to the next build's claim or the next draft. A build that failed before the claim is left out, as the Completed list leaves it.
export function openedPulls(entries: readonly Entry[], logbooks: Logbooks): OpenedPull[] {
	const spent: readonly Spent[] = spentFrom(entries);
	const byUrl = new Map<string, OpenedPull>();
	for (const [feature, book] of logbooks) {
		const mine = spent.filter((s) => s.feature === feature);
		// the times of the claims and drafts, to know where each draft's later rounds stop
		const marks = book.flatMap((e) => {
			const at = timeOf(e.at);
			return at !== null && (e.kind === 'buildStarted' || e.kind === 'pullOpened') ? [at] : [];
		});
		// the claim of the build in flight, and whether an earlier draft already holds the Sessions before this one
		let claim: number | null = null;
		let drafted = false;
		for (const e of book) {
			const at = timeOf(e.at);
			if (at === null) continue;
			if (e.kind === 'buildStarted') {
				claim = at;
				continue;
			}
			if (e.kind !== 'pullOpened') continue;
			// no claim and an earlier draft: the Sessions since then are that draft's later rounds
			const from = claim ?? (drafted ? at : null);
			const until = marks.find((m) => m > at) ?? Infinity;
			let costUsd = 0;
			for (const s of mine) {
				if ((from === null || s.at > from) && s.at <= at) costUsd += s.costUsd;
				else if (s.at > at && s.at < until) costUsd += s.costUsd;
			}
			const known = byUrl.get(e.url);
			byUrl.set(
				e.url,
				known === undefined
					? { url: e.url, at, startedAt: claim, costUsd }
					: { ...known, costUsd: known.costUsd + costUsd }
			);
			drafted = true;
			claim = null;
		}
	}
	return [...byUrl.values()];
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
	readonly logbooks: Logbooks;
	readonly pullStates: PullStates;
	readonly now: Date;
}): Measures {
	const { entries, logbooks, pullStates, now } = o;
	const pulls = withinWindow(openedPulls(entries, logbooks), now);
	const since = now.getTime() - MEASURE_DAYS * DAY_MS;
	const counts = new Map<OutcomeKind, number>();
	for (const e of entries) {
		const at = Date.parse(e.at);
		if (at > since && at <= now.getTime()) {
			const kind = outcomeKind(e);
			counts.set(kind, (counts.get(kind) ?? 0) + 1);
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
