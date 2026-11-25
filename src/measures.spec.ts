import { describe, expect, it } from 'vitest';
import type { PullState } from './code-host.js';
import { measures, median, openedPulls, type PullStates } from './measures.js';
import type { Entry } from './spend.js';
import type { Event, Status } from './status-shape.js';

const NOW = new Date('2026-11-26T12:00:00.000Z');

const session = (
	feature: string,
	at: string,
	costUsd: number,
	over: Partial<Entry> = {}
): Entry => ({
	at,
	repo: 'o/app',
	feature,
	ticket: feature,
	branch: `factory/${feature}-a`,
	step: 'build',
	session: `s-${feature}-${at}`,
	costUsd,
	outcome: 'built',
	durationMs: 60_000,
	...over
});

const pulled = (
	seq: number,
	feature: string,
	startedAt: string | undefined,
	at: string,
	url = `https://code.example/pull/${feature}`
): Event => ({
	kind: 'pull',
	feature,
	url,
	...(startedAt === undefined ? {} : { startedAt }),
	seq,
	at
});

const statusOf = (...recent: Event[]): Status => ({
	at: NOW.toISOString(),
	pid: 1,
	spentTodayUsd: 0,
	dailyUsd: 20,
	doing: { kind: 'off' },
	recent
});

// Three pull requests in the window and one far before it. #1 took 30 minutes and $1.20, #2 an hour and $3.00, #3 ten minutes and $0.40.
const LEDGER: Entry[] = [
	session('1', '2026-11-20T10:10:00.000Z', 0.5),
	session('1', '2026-11-20T10:25:00.000Z', 0.7, { step: 'review', outcome: 'approve' }),
	session('2', '2026-11-21T09:30:00.000Z', 2),
	session('2', '2026-11-21T09:50:00.000Z', 1, { step: 'fix', outcome: 'failed' }),
	session('3', '2026-11-22T08:05:00.000Z', 0.4),
	// a Session from before the 30 days
	session('4', '2026-09-01T08:05:00.000Z', 9, { outcome: 'failed' })
];

const STATUS = statusOf(
	pulled(1, '4', '2026-09-01T08:00:00.000Z', '2026-09-01T08:30:00.000Z'),
	pulled(2, '1', '2026-11-20T10:00:00.000Z', '2026-11-20T10:30:00.000Z'),
	pulled(3, '2', '2026-11-21T09:00:00.000Z', '2026-11-21T10:00:00.000Z'),
	pulled(4, '3', '2026-11-22T08:00:00.000Z', '2026-11-22T08:10:00.000Z')
);

const ours = { message: 'Build #1 A\n\nFactory-Ticket: #1', at: '2026-11-20T10:05:00.000Z' };
const theirs = { message: 'Fix a typo', at: '2026-11-20T11:00:00.000Z' };

const states = (...pairs: [string, PullState][]): PullStates => new Map(pairs);

describe('measures', () => {
	it('gives the median time and cost per pull request and the Sessions by outcome over 30 days', () => {
		const got = measures({ entries: LEDGER, status: STATUS, pullStates: states(), now: NOW });
		expect(got.days).toBe(30);
		// the pull request of September is out of the window
		expect(got.pulls).toBe(3);
		expect(got.timeToPullMs).toBe(30 * 60_000);
		expect(got.costPerPullUsd).toBeCloseTo(1.2);
		expect(got.sessions).toEqual([
			{ outcome: 'built', count: 3 },
			{ outcome: 'approve', count: 1 },
			{ outcome: 'failed', count: 1 }
		]);
	});

	it('takes the median of an even count as the mean of the middle two', () => {
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([5])).toBe(5);
		expect(median([])).toBeNull();
	});

	it('counts the share of merged pull requests whose commits are all Nightjar’s as autonomy', () => {
		const got = measures({
			entries: LEDGER,
			status: STATUS,
			pullStates: states(
				['https://code.example/pull/1', { merged: true, commits: [ours, ours] }],
				['https://code.example/pull/2', { merged: true, commits: [ours, ours] }],
				// open, so it is no merged pull request
				['https://code.example/pull/3', { merged: false, commits: [theirs] }]
			),
			now: NOW
		});
		expect(got.autonomy).toEqual({ kind: 'share', share: 1, merged: 2, autonomous: 2 });
	});

	it('counts a merged pull request with a commit that is not Nightjar’s against autonomy', () => {
		const got = measures({
			entries: LEDGER,
			status: STATUS,
			pullStates: states(
				['https://code.example/pull/1', { merged: true, commits: [ours, ours] }],
				['https://code.example/pull/2', { merged: true, commits: [ours, theirs] }],
				['https://code.example/pull/3', { merged: false, commits: [ours] }]
			),
			now: NOW
		});
		expect(got.autonomy).toEqual({ kind: 'share', share: 0.5, merged: 2, autonomous: 1 });
	});

	it('does not count a merged pull request that lists no commit as Nightjar’s', () => {
		const got = measures({
			entries: LEDGER,
			status: STATUS,
			pullStates: states(['https://code.example/pull/1', { merged: true, commits: [] }]),
			now: NOW
		});
		expect(got.autonomy).toEqual({ kind: 'share', share: 0, merged: 1, autonomous: 0 });
	});

	it('leaves autonomy out when the Code host cannot say, and still gives the other measures', () => {
		const got = measures({ entries: LEDGER, status: STATUS, pullStates: null, now: NOW });
		expect(got.autonomy).toEqual({ kind: 'unavailable' });
		expect(got.timeToPullMs).toBe(30 * 60_000);
		expect(got.costPerPullUsd).toBeCloseTo(1.2);
	});

	it('says autonomy is not read yet while no pull request is known merged and some are unread', () => {
		const got = measures({
			entries: LEDGER,
			status: STATUS,
			pullStates: states(['https://code.example/pull/1', { merged: false, commits: [ours] }]),
			now: NOW
		});
		expect(got.autonomy).toEqual({ kind: 'not read' });
	});

	it('says none merged once every pull request is read and none merged', () => {
		const open: PullState = { merged: false, commits: [ours] };
		const got = measures({
			entries: LEDGER,
			status: STATUS,
			pullStates: states(
				['https://code.example/pull/1', open],
				['https://code.example/pull/2', open],
				['https://code.example/pull/3', open]
			),
			now: NOW
		});
		expect(got.autonomy).toEqual({ kind: 'none merged' });
	});

	it('gives nothing to measure from an empty ledger and status file', () => {
		expect(measures({ entries: [], status: null, pullStates: states(), now: NOW })).toEqual({
			days: 30,
			pulls: 0,
			autonomy: { kind: 'none merged' },
			timeToPullMs: null,
			costPerPullUsd: null,
			sessions: []
		});
	});

	it('skips the time of a pull request whose event lacks when the build began', () => {
		const status = statusOf(pulled(1, '1', undefined, '2026-11-20T10:30:00.000Z'));
		const got = measures({ entries: LEDGER, status, pullStates: states(), now: NOW });
		expect(got.pulls).toBe(1);
		expect(got.timeToPullMs).toBeNull();
		expect(got.costPerPullUsd).toBeCloseTo(1.2);
	});

	it('counts a Feature built again on the same pull request as one, with the cost of every build and the time of the first', () => {
		const status = statusOf(
			pulled(1, '1', '2026-11-20T10:00:00.000Z', '2026-11-20T10:30:00.000Z'),
			pulled(2, '1', '2026-11-22T09:00:00.000Z', '2026-11-22T09:20:00.000Z')
		);
		const ledger = [...LEDGER, session('1', '2026-11-22T09:10:00.000Z', 0.3)];
		const pulls = openedPulls(ledger, status);
		expect(pulls).toHaveLength(1);
		expect(pulls[0]?.costUsd).toBeCloseTo(1.5);
		const got = measures({ entries: ledger, status, pullStates: states(), now: NOW });
		expect(got.pulls).toBe(1);
		expect(got.timeToPullMs).toBe(30 * 60_000);
	});

	it('leaves the cost of a build that failed out of the next pull request', () => {
		const failed: Event = {
			kind: 'failed',
			feature: '1',
			why: 'the check stayed red',
			seq: 1,
			at: '2026-11-19T10:00:00.000Z'
		};
		const status = statusOf(
			failed,
			pulled(2, '1', '2026-11-20T10:00:00.000Z', '2026-11-20T10:30:00.000Z')
		);
		const ledger = [
			session('1', '2026-11-19T09:00:00.000Z', 5, { outcome: 'failed' }),
			session('1', '2026-11-20T10:10:00.000Z', 0.5)
		];
		const got = measures({ entries: ledger, status, pullStates: states(), now: NOW });
		expect(got.costPerPullUsd).toBe(0.5);
	});

	it('ignores a Session or pull request recorded after now', () => {
		const later = session('9', '2026-11-27T08:00:00.000Z', 1);
		const got = measures({
			entries: [...LEDGER, later],
			status: STATUS,
			pullStates: states(),
			now: NOW
		});
		expect(got.sessions.reduce((n, s) => n + s.count, 0)).toBe(5);
	});
});
