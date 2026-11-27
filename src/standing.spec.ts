import { describe, expect, it } from 'vitest';
import type { LogbookEntry } from './logbook.js';
import {
	historyOf,
	logbookMarks,
	NO_HISTORY,
	standingOf,
	type History,
	type StandingInput
} from './standing.js';

const at = (minute: number) => `2026-10-30T08:${String(minute).padStart(2, '0')}:00.000Z`;
const draft: History = { last: null, pull: { url: 'https://code.example/pull/9', at: at(10) } };
const failed: History = { last: { kind: 'failed', at: at(20), why: 'check red' }, pull: null };

// a Feature on the Shelf with nothing known of it, changed by `over`
const input = (over: Partial<StandingInput> = {}): StandingInput => ({
	held: null,
	signal: null,
	listed: true,
	history: NO_HISTORY,
	pause: null,
	...over
});
const standing = (over: Partial<StandingInput>) => standingOf(input(over))?.standing ?? null;

describe('standingOf', () => {
	it('puts a Feature a Slot holds in Building first, whatever its Signals and pull request, since its claim', () => {
		const held = { held: at(30), history: draft };
		expect(standingOf(input({ ...held, signal: 'waiting' }))).toMatchObject({
			standing: 'building',
			since: at(30)
		});
		expect(standing({ ...held, signal: 'go' })).toBe('building');
		// a Slot holds it even where the Tracker's lists do not
		expect(standing({ ...held, listed: false })).toBe('building');
	});

	it('puts needs info or needs a person in Waiting on you, even with an open pull request', () => {
		expect(standing({ signal: 'waiting', history: draft })).toBe('waiting');
	});

	it('puts a failed last build with no Signal in Waiting on you, and with the Go in the Queue, saying it failed', () => {
		expect(standingOf(input({ history: failed }))).toEqual({
			standing: 'waiting',
			failed: 'check red'
		});
		expect(standingOf(input({ signal: 'go', history: failed }))).toEqual({
			standing: 'queue',
			failed: 'check red'
		});
		// a build begun since is not the failed one
		const again = historyOf([
			{ kind: 'failed', at: at(20), why: 'check red' },
			{ kind: 'started', at: at(25) }
		]);
		expect(standing({ history: again })).toBe('shelf');
	});

	it('keeps a paused Feature in the Queue, paused until the run pause ends, when it has an end', () => {
		const paused: History = { last: { kind: 'paused', at: at(20), why: 'limit' }, pull: null };
		expect(standingOf(input({ signal: 'go', history: paused }))).toEqual({
			standing: 'queue',
			paused: { until: null }
		});
		const pause = { until: at(50) };
		expect(standingOf(input({ signal: 'go', history: paused, pause }))).toEqual({
			standing: 'queue',
			paused: { until: at(50) }
		});
	});

	it('puts a draft with no Signal and no Slot in Pull request, since it opened, its state unknown', () => {
		expect(standingOf(input({ history: draft }))).toEqual({
			standing: 'pull',
			since: at(10),
			pull: { url: 'https://code.example/pull/9', at: at(10), state: 'unknown' }
		});
		// the page cannot tell where the Tracker lists it
		expect(standing({ history: draft, listed: undefined })).toBe('pull');
	});

	it('puts a stopped Feature in Pull request with its draft, else on the Shelf, saying a person stopped it', () => {
		const stopped = { kind: 'stopped', at: at(30) } as const;
		expect(standingOf(input({ history: { ...draft, last: stopped } }))).toMatchObject({
			standing: 'pull',
			stopped: true
		});
		expect(standingOf(input({ history: { last: stopped, pull: null } }))).toEqual({
			standing: 'shelf',
			stopped: true
		});
	});

	it('leaves off the Board a Feature the whole lists hold nowhere, and one it knows nothing to show of', () => {
		expect(standingOf(input({ listed: false, history: draft }))).toBeNull();
		expect(standingOf(input({ listed: false, history: failed }))).toBeNull();
		// the Shelf holds only what the Tracker lists there
		expect(standingOf(input({ listed: undefined }))).toBeNull();
		expect(standing({})).toBe('shelf');
	});

	it('never answers Merged while the page knows a pull request only from a Logbook', () => {
		const answers = [draft, failed, NO_HISTORY].flatMap((history) =>
			[true, undefined].map((listed) => standing({ history, listed }))
		);
		expect(answers).not.toContain('merged');
	});
});

describe('historyOf and logbookMarks', () => {
	const entry = (minute: number, decision: Record<string, unknown>) =>
		({ ...decision, at: at(minute), feature: '7' }) as LogbookEntry;

	it('reads how the last build ended and the draft it opened from a Logbook, in time order', () => {
		const marks = logbookMarks([
			entry(1, { kind: 'buildStarted', by: 'go', branch: 'b', workflow: null }),
			entry(10, { kind: 'pullOpened', url: 'https://code.example/pull/9', created: true }),
			entry(20, { kind: 'buildStarted', by: 'feedback', branch: 'b', workflow: null }),
			// the open one given a new body keeps the time it opened
			entry(30, { kind: 'pullOpened', url: 'https://code.example/pull/9', created: false }),
			entry(40, { kind: 'pullFix', round: 1, rounds: 2, failing: [], end: 'stopped' })
		]);
		expect(historyOf(marks)).toEqual({
			last: { kind: 'stopped', at: at(40) },
			pull: { url: 'https://code.example/pull/9', at: at(10) }
		});
	});

	it('reads a fault as a failure, a stop as a stop, and other work as nothing', () => {
		const marks = logbookMarks([
			entry(5, { kind: 'thrownAway', branch: null, why: 'stopped by a person' }),
			entry(6, { kind: 'thrownAway', branch: 'b-attempt', why: 'the check stayed red' }),
			entry(7, { kind: 'ticketStarted' }),
			entry(8, { kind: 'fault', place: 'in the check', why: 'boom', passing: false })
		]);
		expect(marks.map((m) => m.kind)).toEqual(['stopped', 'failed']);
		expect(historyOf(marks).last).toEqual({ kind: 'failed', at: at(8), why: 'boom' });
		expect(historyOf([])).toEqual(NO_HISTORY);
	});
});
