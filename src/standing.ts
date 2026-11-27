// A Feature's Standing (GLOSSARY.md): where it stands in its life, worked out by one rule from what the page knows of it. The Board, the Table and the Overview all read this one answer, so they cannot drift apart.
import type { LogbookEntry } from './logbook.js';

// In the order a Feature moves.
export const STANDINGS = ['shelf', 'queue', 'building', 'waiting', 'pull', 'merged'] as const;
export type Standing = (typeof STANDINGS)[number];

// One thing .factory/ records of a Feature's builds, as the rule reads it: a build began, or how one ended.
export type Mark =
	| { readonly kind: 'started'; readonly at: string }
	| { readonly kind: 'failed'; readonly at: string; readonly why: string }
	// a draft pull request: a new one (`created`), or the branch's open one with a new body
	| { readonly kind: 'pull'; readonly at: string; readonly url: string; readonly created: boolean }
	| { readonly kind: 'paused'; readonly at: string; readonly why: string }
	| { readonly kind: 'stopped'; readonly at: string }
	// handed to a person with needs info or needs a person, which the Tracker's Signals say better
	| { readonly kind: 'handed'; readonly at: string };

// How Nightjar says a person stopped a piece of work, in a ledger line's outcome and a Logbook's thrownAway.
export const STOPPED_BY_A_PERSON = 'stopped by a person';

// The marks of a Feature's Logbook entries, oldest first.
export function logbookMarks(entries: readonly LogbookEntry[]): Mark[] {
	return entries.flatMap((e): Mark[] => {
		const { at } = e;
		switch (e.kind) {
			case 'buildStarted':
				return [{ kind: 'started', at }];
			case 'fault':
				return [{ kind: 'failed', at, why: e.why }];
			case 'pullOpened':
				return [{ kind: 'pull', at, url: e.url, created: e.created }];
			case 'paused':
				return [{ kind: 'paused', at, why: e.why }];
			case 'handed':
				return [{ kind: 'handed', at }];
			case 'thrownAway':
				return e.why === STOPPED_BY_A_PERSON ? [{ kind: 'stopped', at }] : [];
			case 'feedbackRound':
			case 'pullFix':
				return e.end === 'stopped' ? [{ kind: 'stopped', at }] : [];
			default:
				return [];
		}
	});
}

// What .factory/ knows of a Feature's builds.
export interface History {
	// how its last build ended; null when none did, or a build began since
	readonly last: Exclude<Mark, { kind: 'started' }> | null;
	// the draft pull request its builds opened: the latest url, and when it was opened
	readonly pull: { readonly url: string; readonly at: string } | null;
}

export const NO_HISTORY: History = { last: null, pull: null };

const time = (iso: string) => Date.parse(iso) || 0;

// A Feature's History from its marks, in any order; at the same moment the order given holds.
export function historyOf(marks: readonly Mark[]): History {
	let last: History['last'] = null;
	let pull: History['pull'] = null;
	for (const m of [...marks].sort((a, b) => time(a.at) - time(b.at))) {
		if (m.kind === 'started') {
			last = null;
			continue;
		}
		last = m;
		// a new pull request starts the clock again; the open one given a new body keeps it
		if (m.kind === 'pull') pull = { url: m.url, at: m.created || pull === null ? m.at : pull.at };
	}
	return { last, pull };
}

// What the rule reads of one Feature.
export interface StandingInput {
	// when the Slot that holds it claimed it; null when no Slot does
	readonly held: string | null;
	// the Signal it carries, as the Tracker read lists it: the Go, needs info or needs a person (both `waiting`), or none
	readonly signal: 'go' | 'waiting' | null;
	// true when the Tracker lists it (on the Shelf, the Queue or Waiting on you); false when its lists are whole and it is on none, so it is closed or not the person's; undefined when the page cannot tell
	readonly listed: boolean | undefined;
	readonly history: History;
	// the pause the run is under; null when it is not paused
	readonly pause: { readonly until: string | null } | null;
}

// Where the Feature stands, and the facts its card shows.
export interface StandingAnswer {
	readonly standing: Standing;
	// when it entered its Standing, where the page knows it for free: the claim (Building), the pull request's opening (Pull request)
	readonly since?: string;
	// its last build failed, and why
	readonly failed?: string;
	// its last build paused; until when, while the run's pause has an end
	readonly paused?: { readonly until: string | null };
	// a person stopped its last build
	readonly stopped?: true;
	// its pull request. Its state is `unknown` while the page knows it only from a Logbook, which says a draft opened and nothing after
	readonly pull?: { readonly url: string; readonly at: string; readonly state: 'unknown' };
}

// The one rule: the first Standing that applies. Null for a Feature that is not on the Board: closed or not the person's, or one the page knows nothing of to show.
export function standingOf(i: StandingInput): StandingAnswer | null {
	const { last, pull } = i.history;
	const pr = pull === null ? {} : { pull: { ...pull, state: 'unknown' as const } };
	if (i.held !== null) return { standing: 'building', since: i.held, ...pr };
	if (i.listed === false) return null;
	const notes = {
		...(last?.kind === 'failed' ? { failed: last.why } : {}),
		...(last?.kind === 'paused' ? { paused: { until: i.pause?.until ?? null } } : {}),
		...(last?.kind === 'stopped' ? { stopped: true as const } : {})
	};
	if (i.signal === 'waiting' || (i.signal === null && last?.kind === 'failed'))
		return { standing: 'waiting', ...notes, ...pr };
	if (i.signal === 'go') return { standing: 'queue', ...notes, ...pr };
	if (pull !== null) return { standing: 'pull', since: pull.at, ...notes, ...pr };
	// the Shelf holds only what the Tracker lists there
	return i.listed === true ? { standing: 'shelf', ...notes } : null;
}
