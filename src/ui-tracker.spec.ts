// The page's read of the Tracker, and what the page says for it, over a fake Tracker; no server, so it runs where no port may be bound.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTracker } from './fakes/tracker.js';
import { readFactory } from './status-reader.js';
import { StatusFile } from './status.js';
import { fileSpend, ledgerPath } from './ledger.js';
import { renderPanels } from './ui.js';
import {
	listsFrom,
	readUpcoming,
	TRACKER_EVERY_MS,
	watchTracker,
	type ReadingTracker,
	type TrackerLists,
	type Upcoming
} from './ui-tracker.js';

const at = new Date(Date.UTC(2026, 9, 30, 9, 0));

// #1 with the Go and two Tickets, one closed; #4 a lone issue that needs info; #5 a lone issue that needs a person
const fakeTracker = () =>
	new FakeTracker('ann', () => at)
		.add({
			id: '1',
			title: 'Saved filters',
			assignees: ['ann'],
			signals: ['go'],
			children: ['2', '3']
		})
		.add({ id: '2', title: 'Model', open: false })
		.add({ id: '3', title: 'View' })
		.add({ id: '4', title: 'Audit log', assignees: ['ann'], signals: ['needsInfo'] })
		.add({ id: '5', title: 'SSO', assignees: ['ann'], signals: ['human'] });

describe('readUpcoming', () => {
	it('reads the Queue and Waiting on you, with Ticket counts, and writes nothing', async () => {
		const tracker = fakeTracker();
		const before = structuredClone([...tracker.items.values()]);
		const got = await readUpcoming({ tracker, person: 'ann' }, () => at);
		expect(got).toEqual({
			queue: [{ id: '1', title: 'Saved filters', ticketCounts: { total: 2, closed: 1 } }],
			waiting: [
				{
					kind: 'feature',
					id: '4',
					title: 'Audit log',
					why: 'needs info',
					ticketCounts: { total: 1, closed: 0 }
				},
				{
					kind: 'feature',
					id: '5',
					title: 'SSO',
					why: 'needs a person',
					ticketCounts: { total: 1, closed: 0 }
				}
			],
			trackerCannotList: false,
			at: at.toISOString()
		});
		expect([...tracker.items.values()]).toEqual(before);
	});

	it('says when the Tracker cannot list what waits, and leaves out counts it cannot read', async () => {
		const fake = fakeTracker();
		const tracker: ReadingTracker = { assignedFeatures: (p) => fake.assignedFeatures(p) };
		const got = await readUpcoming({ tracker, person: 'ann' }, () => at);
		expect(got.trackerCannotList).toBe(true);
		expect(got.waiting).toEqual([]);
		expect(got.queue).toEqual([{ id: '1', title: 'Saved filters' }]);
	});

	it('gives each count as unknown when counting fails, and still gives the lists', async () => {
		const fake = fakeTracker();
		const tracker: ReadingTracker = {
			assignedFeatures: (p) => fake.assignedFeatures(p),
			waitingOn: (p) => fake.waitingOn(p),
			ticketCounts: () => Promise.reject(new Error('gh: HTTP 502'))
		};
		const got = await readUpcoming({ tracker, person: 'ann' }, () => at);
		expect(got.queue).toEqual([{ id: '1', title: 'Saved filters', ticketCounts: null }]);
		expect(got.waiting.map((w) => w.ticketCounts)).toEqual([null, null]);
	});
});

describe('listsFrom', () => {
	it('opens the Tracker once, and again after an open that failed', async () => {
		let opens = 0;
		const read = listsFrom(() => {
			opens += 1;
			return opens === 1
				? Promise.reject(new Error('gh: not signed in'))
				: Promise.resolve({ tracker: fakeTracker(), person: 'ann' });
		});
		await expect(read()).rejects.toThrow('gh: not signed in');
		expect((await read()).queue.map((q) => q.id)).toEqual(['1']);
		await read();
		expect(opens).toBe(2);
	});
});

describe('watchTracker', () => {
	let ticks: { ms: number; tick: () => void }[];
	let changes: number;
	beforeEach(() => {
		ticks = [];
		changes = 0;
	});
	const watching = (read: () => Promise<Upcoming>) =>
		watchTracker({
			read,
			changed: () => {
				changes += 1;
			},
			every: (ms, tick) => {
				ticks.push({ ms, tick });
				return () => {};
			},
			now: () => at
		});
	const tracker = fakeTracker();
	const upcoming = () => readUpcoming({ tracker, person: 'ann' }, () => at);

	it('reads at once and then each minute, one read at a time', async () => {
		let reads = 0;
		const watch = watching(() => {
			reads += 1;
			return upcoming();
		});
		expect(watch.lists()).toEqual({ last: null, fault: null });
		expect(ticks.map((t) => t.ms)).toEqual([TRACKER_EVERY_MS]);
		expect(TRACKER_EVERY_MS).toBe(60_000);
		// a minute that comes while a read is in flight starts no second one
		ticks[0]?.tick();
		await watch.reading();
		expect(reads).toBe(1);
		expect(changes).toBe(1);
		expect(watch.lists().last?.queue.map((q) => q.id)).toEqual(['1']);
		ticks[0]?.tick();
		await watch.reading();
		expect(reads).toBe(2);
		expect(changes).toBe(2);
	});

	it('keeps the last lists when a read fails, says why and when, and clears it on the next good read', async () => {
		let down = false;
		const watch = watching(() =>
			down ? Promise.reject(new Error('gh: Bad Gateway (HTTP 502)')) : upcoming()
		);
		await watch.reading();
		const last = watch.lists().last;
		down = true;
		ticks[0]?.tick();
		await watch.reading();
		expect(watch.lists()).toEqual({
			last,
			fault: { at: at.toISOString(), why: 'gh: Bad Gateway (HTTP 502)' }
		});
		down = false;
		ticks[0]?.tick();
		await watch.reading();
		expect(watch.lists().fault).toBeNull();
	});

	it('tells no change once stopped, and reads no more', async () => {
		let reads = 0;
		const watch = watching(() => {
			reads += 1;
			return upcoming();
		});
		watch.stop();
		await watch.reading();
		ticks[0]?.tick();
		await watch.reading();
		expect(changes).toBe(0);
		expect(reads).toBe(1);
	});
});

describe('the page over what it read of the Tracker', () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'nightjar-ui-tracker-'));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});
	const panels = (tracker?: TrackerLists) =>
		renderPanels(root, readFactory(root, { now: () => at, alive: () => true }), undefined, tracker);
	const mat = (html: string, state: string) =>
		(html.split('<div class="table">')[0] ?? '')
			.split(`<section class="mat" data-state="${state}"`)[1]
			?.split('<section')[0] ?? '';
	const read = async (tracker: ReadingTracker = fakeTracker()) =>
		readUpcoming({ tracker, person: 'ann' }, () => at);

	it('shows the Queue and Waiting on you while nightjar is off, and when it read them', async () => {
		const html = panels({ last: await read(), fault: null });
		expect(html).toContain('<span class="state">off</span>');
		expect(html).not.toContain('not known while nightjar is off');
		expect(mat(html, 'queue')).toContain('Saved filters');
		expect(mat(html, 'queue')).toContain('0 of 2 built');
		expect(mat(html, 'waiting')).toContain('Audit log');
		expect(mat(html, 'waiting')).toContain('needs a person');
		expect(html).toMatch(/waiting on you<\/span> <b>2<\/b>/);
		expect(html).toContain(`Tracker read <time datetime="${at.toISOString()}">`);
		expect(html.split('<div class="table">')[1]).toContain('data-title="Saved filters"');
		expect(html.split('<div class="overview">')[1]).toContain('Audit log');
	});

	it('marks the lists it kept with their age when the last read failed', async () => {
		const html = panels({
			last: await read(),
			fault: { at: at.toISOString(), why: 'gh: Bad Gateway (HTTP 502)' }
		});
		expect(mat(html, 'queue')).toContain('Saved filters');
		const header = html.split('<header>')[1]?.split('</header>')[0] ?? '';
		expect(header).toContain('class="read stale"');
		expect(header).toContain(`<time data-since="${at.toISOString()}"></time> ago`);
		expect(header).toContain('gh: Bad Gateway (HTTP 502)');
	});

	it('says it is reading, or why it could not read, in place of the lists', () => {
		expect(mat(panels({ last: null, fault: null }), 'queue')).toContain('reading the Tracker');
		const failed = panels({ last: null, fault: { at: at.toISOString(), why: 'gh: <down>' } });
		expect(mat(failed, 'queue')).toContain('could not read the Tracker: gh: &#60;down&#62;');
		expect(mat(failed, 'waiting')).toContain('could not read the Tracker');
		expect(failed).not.toContain('not known while nightjar is off');
	});

	it('still says Waiting on you is not available from a Tracker without waitingOn', async () => {
		const fake = fakeTracker();
		const html = panels({
			last: await read({ assignedFeatures: (p) => fake.assignedFeatures(p) }),
			fault: null
		});
		expect(mat(html, 'waiting')).toContain('not available from this Tracker');
		expect(mat(html, 'queue')).toContain('Saved filters');
	});

	it("takes the Tracker's lists over status.json's, keeps the run's waiting Tickets, and queues no Feature being built", async () => {
		const file = new StatusFile({
			path: join(root, '.factory', 'status.json'),
			spend: fileSpend(ledgerPath(root)),
			now: () => at,
			pid: 42,
			dailyUsd: 8
		});
		file.refreshed([{ id: '50', title: 'Old queue' }], { items: [], trackerCannotList: false });
		// while a Feature builds, status.json lists its own Tickets that wait
		file.doing({
			kind: 'building',
			feature: '1',
			title: 'Saved filters',
			ticket: '3',
			step: 'build',
			round: null,
			rounds: null,
			session: null,
			startedAt: at.toISOString(),
			tickets: [
				{ id: '3', title: 'View', state: 'building' },
				{ id: '12', title: 'Facets', state: 'waiting', why: 'needs info' }
			]
		});
		const html = panels({ last: await read(), fault: null });
		expect(html).not.toContain('Old queue');
		expect(mat(html, 'queue')).not.toContain('Saved filters');
		expect(mat(html, 'building')).toContain('Saved filters');
		expect(mat(html, 'waiting')).toContain('Audit log');
		expect(mat(html, 'waiting')).toContain('Facets');
	});

	it("shows status.json's lists while a run goes and no read has gone well yet", () => {
		const file = new StatusFile({
			path: join(root, '.factory', 'status.json'),
			spend: fileSpend(ledgerPath(root)),
			now: () => at,
			pid: 42,
			dailyUsd: 8
		});
		file.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		file.refreshed([{ id: '50', title: 'Old queue' }], { items: [], trackerCannotList: false });
		expect(mat(panels({ last: null, fault: null }), 'queue')).toContain('Old queue');
	});
});
