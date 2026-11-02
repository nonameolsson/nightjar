import { describe, expect, it } from 'vitest';
import { renderBlock } from './live-view.js';
import type { Done, FactoryView } from './status-reader.js';
import type { Doing, Status } from './status.js';

const now = new Date(2026, 9, 30, 9, 30, 0);
const iso = (h: number, m: number, s = 0) => new Date(2026, 9, 30, h, m, s).toISOString();

const status = (doing: Doing, more: Partial<Status> = {}): Status => ({
	at: now.toISOString(),
	pid: 42,
	spentTodayUsd: 3.42,
	dailyUsd: 8,
	doing,
	recent: [],
	...more
});

const building = (more: Partial<Extract<Doing, { kind: 'building' }>> = {}): Doing => ({
	kind: 'building',
	feature: '272',
	title: 'Custom views',
	ticket: '3',
	step: 'build',
	round: 1,
	rounds: 3,
	session: 's1',
	startedAt: iso(9, 18, -4),
	tickets: [
		{ id: '1', title: 'a', state: 'built' },
		{ id: '2', title: 'b', state: 'built' },
		{ id: '3', title: 'c', state: 'building' },
		{ id: '4', title: 'd', state: 'waiting', why: 'waits for #3' },
		{ id: '5', title: 'e', state: 'waiting', why: 'waits for #3' }
	],
	...more
});

const view = (s: Status | null, more: Partial<FactoryView> = {}): FactoryView => ({
	status: s,
	stopped: false,
	tail: [],
	completed: [],
	featureCostUsd: 0,
	builtToday: 0,
	...more
});

const render = (v: FactoryView, width = 80, line: string | null = null) =>
	renderBlock(v, { repo: 'o/app', width, now, line });

const done = (kind: 'pull' | 'failed', at: string, title: string | undefined, id: string): Done =>
	kind === 'pull'
		? { seq: 1, at, kind, feature: id, ...(title === undefined ? {} : { title }), url: 'u' }
		: {
				seq: 2,
				at,
				kind,
				feature: id,
				...(title === undefined ? {} : { title }),
				why: 'check red'
			};

describe('renderBlock', () => {
	it('shows a build: header, Feature with elapsed and cost, Ticket progress, newest session line, today', () => {
		const s = status(building(), {
			queue: [
				{ id: '275', title: 'Saved filters' },
				{ id: '281', title: 'CSV export' }
			],
			waitingOnYou: {
				trackerCannotList: false,
				items: [{ kind: 'feature', id: '268', title: 'Webhook retries', why: 'needs info' }]
			}
		});
		const lines = render(
			view(s, {
				tail: ['Read a.ts', 'run npm run check'],
				featureCostUsd: 1.18,
				builtToday: 5,
				completed: [
					{ event: done('failed', iso(8, 12), undefined, '249'), costUsd: 0 },
					{ event: done('pull', iso(8, 47), 'Search box', '254'), costUsd: 1.61 },
					{ event: done('pull', iso(9, 21), 'Dark mode', '259'), costUsd: 2.04 }
				]
			})
		);
		expect(lines).toEqual([
			'nightjar  o/app  ·  watching',
			'',
			'● #272 Custom views                                              12m 04s   $1.18',
			'  Ticket 3/5  build, round 1/3',
			'  ████████████████░░░░░░░░░░░░░░░░░░░░░░░░',
			'  ▸ run npm run check',
			'',
			'Today   $3.42 / $8  ████████░░░░░░░░░░░░  5 Tickets built',
			'',
			'Queue           #275 Saved filters   #281 CSV export',
			'Waiting on you  #268 Webhook retries: needs info',
			'',
			'Recent',
			'  ✓ 09:21  #259 Dark mode   draft PR  $2.04',
			'  ✓ 08:47  #254 Search box  draft PR  $1.61',
			'  ✗ 08:12  #249             check red'
		]);
	});

	it('counts down to the next poll while idle, and from the time it is given', () => {
		const idle = status({ kind: 'idle', nextPollAt: iso(9, 31, 12) });
		expect(render(view(idle))[0]).toBe('nightjar  o/app  ·  idle  ·  next poll 1:12');
		const later = renderBlock(view(idle), {
			repo: 'o/app',
			width: 80,
			now: new Date(2026, 9, 30, 9, 30, 30),
			line: null
		});
		expect(later[0]).toBe('nightjar  o/app  ·  idle  ·  next poll 0:42');
	});

	it('says paused with why, stopped for a dead run whatever it was doing, and off for no run yet', () => {
		const paused = status({ kind: 'paused', why: 'daily limit', until: iso(10, 0) });
		expect(render(view(paused))[0]).toBe(
			'nightjar  o/app  ·  paused: daily limit  ·  next poll 30:00'
		);
		const lines = render(view(status(building()), { stopped: true }));
		expect(lines[0]).toBe('nightjar  o/app  ·  stopped');
		expect(lines.some((l) => l.startsWith('●'))).toBe(false);
		expect(render(view(null))[0]).toBe('nightjar  o/app  ·  no run yet');
	});

	it('hides the Queue and Waiting on you of a stopped or off run, as the web UI does', () => {
		const stale = {
			queue: [{ id: '275', title: 'Saved filters' }],
			waitingOnYou: {
				trackerCannotList: false,
				items: [{ kind: 'feature' as const, id: '268', title: 'Retries', why: 'needs info' }]
			}
		};
		const idle: Doing = { kind: 'idle', nextPollAt: iso(9, 31) };
		const dead = render(view(status(idle, stale), { stopped: true }));
		const off = render(view(status({ kind: 'off' }, stale)));
		for (const lines of [dead, off]) {
			expect(lines.some((l) => l.startsWith('Queue'))).toBe(false);
			expect(lines.some((l) => l.startsWith('Waiting on you'))).toBe(false);
			expect(lines.some((l) => l.startsWith('Today'))).toBe(true);
		}
	});

	it('says what an older status.json or a Tracker without waitingOn cannot show', () => {
		const old = render(view(status({ kind: 'idle', nextPollAt: iso(9, 31) })));
		expect(old).toContain('Queue           not read yet');
		expect(old).toContain('Waiting on you  not read yet');
		const cannot = status(
			{ kind: 'idle', nextPollAt: iso(9, 31) },
			{ queue: [], waitingOnYou: { items: [], trackerCannotList: true } }
		);
		const lines = render(view(cannot));
		expect(lines).toContain('Queue           empty');
		expect(lines).toContain('Waiting on you  not available from this Tracker');
		const none = status(
			{ kind: 'idle', nextPollAt: iso(9, 31) },
			{ queue: [], waitingOnYou: { items: [], trackerCannotList: false } }
		);
		expect(render(view(none))).toContain('Waiting on you  nothing');
	});

	it('shows only the step when there is no Ticket list, and the step alone during review', () => {
		const old = render(view(status(building({ tickets: undefined }))));
		expect(old).toContain('  build, round 1/3');
		expect(old.some((l) => l.includes('█') && !l.startsWith('Today'))).toBe(false);
		const review = render(
			view(status(building({ ticket: null, step: 'review', round: null, rounds: null })))
		);
		expect(review).toContain('  2/5 Tickets built  review');
	});

	it('shows the newest say() line at the foot, and holds every line to the width', () => {
		const lines = render(
			view(status(building()), { tail: ['x'.repeat(200)] }),
			40,
			'nightjar: #272 failed: ' + 'y'.repeat(100)
		);
		expect(lines.at(-1)).toMatch(/^nightjar: #272 failed: y+…$/);
		for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(40);
	});
});
