// The page's read of the Tracker, and what the page says for it, over a fake Tracker; no server, so it runs where no port may be bound.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTracker } from './fakes/tracker.js';
import { SHELF_MAX } from './tracker.js';
import { NO_LINKS, type Links } from './ui-links.js';
import { readFactory } from './status-reader.js';
import { StatusFile } from './status.js';
import { fileSpend, ledgerPath } from './ledger.js';
import { renderPanels } from './ui.js';
import {
	listsFrom,
	openOnce,
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

// the same, with two Features on the Shelf: #6 a lone issue, then #7 with a Ticket, updated later; #9 is Bob's and on no Shelf of Ann's
const shelfTracker = () =>
	fakeTracker()
		.add({ id: '6', title: 'Old idea', assignees: ['ann'] })
		.add({ id: '8', title: 'Export' })
		.add({ id: '7', title: 'Reports <b>', assignees: ['ann'], children: ['8'] })
		.add({ id: '9', title: 'Theirs', assignees: ['bob'] });

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
			shelf: { features: [], total: 0 },
			person: 'ann',
			at: at.toISOString()
		});
		expect([...tracker.items.values()]).toEqual(before);
	});

	it("reads the person's Shelf, at most SHELF_MAX of it, with how many there are in all", async () => {
		const tracker = shelfTracker();
		for (let i = 0; i < SHELF_MAX; i += 1)
			tracker.add({ id: `1${String(i)}0`, title: `Idea ${String(i)}`, assignees: ['ann'] });
		const got = await readUpcoming({ tracker, person: 'ann' }, () => at);
		expect(got.shelf?.features).toHaveLength(SHELF_MAX);
		expect(got.shelf?.total).toBe(SHELF_MAX + 2);
		// the newest update first, and nothing of the Queue or of what waits
		expect(got.shelf?.features[0]?.title).toBe(`Idea ${String(SHELF_MAX - 1)}`);
		expect(got.shelf?.features.map((f) => f.id)).not.toContain('1');
		expect(got.shelf?.features.map((f) => f.id)).not.toContain('4');
	});

	it('says when the Tracker cannot list what waits, and leaves out counts it cannot read', async () => {
		const fake = fakeTracker();
		const tracker: ReadingTracker = { assignedFeatures: (p) => fake.assignedFeatures(p) };
		const got = await readUpcoming({ tracker, person: 'ann' }, () => at);
		expect(got.trackerCannotList).toBe(true);
		expect(got.shelf).toBeNull();
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

describe('openOnce', () => {
	it('opens the Tracker once, and again after an open that failed', async () => {
		let opens = 0;
		const read = listsFrom(
			openOnce(() => {
				opens += 1;
				return opens === 1
					? Promise.reject(new Error('gh: not signed in'))
					: Promise.resolve({ tracker: fakeTracker(), person: 'ann' });
			})
		);
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
	const panels = (tracker?: TrackerLists, links?: Links) =>
		renderPanels(root, readFactory(root, { now: () => at, alive: () => true }), links, tracker);
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

	describe('the Shelf', () => {
		const board = (html: string) => html.split('<div class="table">')[0] ?? '';
		const onGitHub: Links = {
			...NO_LINKS,
			tracker: 'GitHub',
			issues: 'https://github.com/o/app/issues',
			assigned: (person) =>
				`https://github.com/o/app/issues?q=${encodeURIComponent(`is:issue is:open assignee:${person}`)}`
		};

		it('is a fifth Mat between Queue and Completed, newest update first, with its tally', async () => {
			const html = panels({ last: await read(shelfTracker()), fault: null });
			const states = ['waiting', 'building', 'queue', 'shelf', 'completed'];
			const pos = (s: string) => board(html).indexOf(`<section class="mat" data-state="${s}"`);
			expect(pos('waiting')).toBeGreaterThanOrEqual(0);
			expect(states.map(pos)).toEqual(states.map(pos).sort((a, b) => a - b));
			const shelf = mat(html, 'shelf');
			expect(shelf).toContain('<h2>Shelf</h2><i class="tally">2</i>');
			expect(shelf.indexOf('Reports')).toBeGreaterThan(-1);
			expect(shelf.indexOf('Reports')).toBeLessThan(shelf.indexOf('Old idea'));
			expect(shelf).not.toContain('Theirs');
			// Features with the Go or a Signal are in their own Mats, not here
			expect(shelf).not.toContain('Saved filters');
			expect(shelf).not.toContain('Audit log');
			// the Tracker's text is shown as text
			expect(shelf).toContain('Reports &#60;b&#62;');
			expect(shelf).not.toContain('<b>Reports');
		});

		it('labels an item with no Tickets as a Lone issue, and one with Tickets not', async () => {
			const shelf = mat(panels({ last: await read(shelfTracker()), fault: null }), 'shelf');
			const [reports = '', idea = ''] = shelf.split('<article').slice(1);
			expect(idea).toContain('Old idea');
			expect(idea).toContain('Lone issue');
			expect(reports).toContain('Reports');
			expect(reports).not.toContain('Lone issue');
		});

		it('is a group in the Table and in the Overview too', async () => {
			const html = panels({ last: await read(shelfTracker()), fault: null });
			const [, rest = ''] = html.split('<div class="table">');
			const [table = '', overview = ''] = rest.split('<div class="overview">');
			expect(table).toContain('<button type="button" data-chip="shelf">Shelf</button>');
			expect(table).toMatch(/<tr data-state="shelf"[^>]*data-title="Old idea"/);
			expect(table).toMatch(/<tr data-state="shelf"[^>]*data-title="Reports &#60;b&#62;"/);
			const [, after = ''] = overview.split('<section id="shelf">');
			const [section = ''] = after.split('</section>');
			expect(section).toContain('<h2>Shelf</h2>');
			expect(section).toContain('Old idea');
			expect(section).toContain('Lone issue');
		});

		it('lists at most 50, then "and N more in the Tracker" as a link to their open issues', async () => {
			const tracker = shelfTracker();
			for (let i = 0; i < SHELF_MAX; i += 1)
				tracker.add({ id: `1${String(i)}0`, title: `Idea ${String(i)}`, assignees: ['ann'] });
			const lists = { last: await read(tracker), fault: null };
			const shelf = mat(panels(lists, onGitHub), 'shelf');
			expect(shelf.match(/<article/g)).toHaveLength(SHELF_MAX);
			// the tally counts them all, the Mat lists 50
			expect(shelf).toContain(`<i class="tally">${String(SHELF_MAX + 2)}</i>`);
			expect(shelf).toContain(
				'<a class="ext" href="https://github.com/o/app/issues?q=is%3Aissue%20is%3Aopen%20assignee%3Aann" target="_blank" rel="noreferrer noopener">and 2 more in the Tracker</a>'
			);
			expect(shelf).not.toContain('Old idea');
			// no link when the page knows no Tracker page; the words stay
			const unlinked = mat(panels(lists), 'shelf');
			expect(unlinked).toContain('<p class="more">and 2 more in the Tracker</p>');
		});

		it('names no more when the whole Shelf is listed, and says when it is empty', async () => {
			const whole = mat(panels({ last: await read(shelfTracker()), fault: null }), 'shelf');
			expect(whole).not.toContain('more in the Tracker');
			const empty = mat(panels({ last: await read(), fault: null }), 'shelf');
			expect(empty).toContain('empty');
			expect(empty).toContain('<i class="tally">0</i>');
		});

		it('says it is not available from a Tracker without it, and the rest of the page works', async () => {
			const fake = shelfTracker();
			const tracker: ReadingTracker = {
				assignedFeatures: (p) => fake.assignedFeatures(p),
				waitingOn: (p) => fake.waitingOn(p)
			};
			const html = panels({ last: await read(tracker), fault: null });
			expect(mat(html, 'shelf')).toContain('Shelf is not available from this Tracker');
			expect(mat(html, 'shelf')).not.toContain('class="tally"');
			expect(mat(html, 'queue')).toContain('Saved filters');
			expect(mat(html, 'waiting')).toContain('Audit log');
			expect(mat(html, 'waiting')).not.toContain('not available');
			const rest = html.split('<div class="table">')[1] ?? '';
			expect(rest).toContain('Shelf is not available from this Tracker');
			expect(rest).toContain('data-title="Saved filters"');
		});

		it('says it is reading, or why it could not read, until a read has gone well', () => {
			expect(mat(panels({ last: null, fault: null }), 'shelf')).toContain('reading the Tracker');
			const failed = panels({ last: null, fault: { at: at.toISOString(), why: 'gh: down' } });
			expect(mat(failed, 'shelf')).toContain('could not read the Tracker: gh: down');
		});
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
		// the building Feature's waiting Ticket sits on its Building card
		expect(mat(html, 'building')).toContain('Facets');
		expect(mat(html, 'waiting')).not.toContain('Facets');
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

	it('makes the title of each Feature on Waiting on you, the Queue and the Shelf a button that opens its panel, in every view', async () => {
		const file = new StatusFile({
			path: join(root, '.factory', 'status.json'),
			spend: fileSpend(ledgerPath(root)),
			now: () => at,
			pid: 42,
			dailyUsd: 8
		});
		file.happened({ kind: 'pull', feature: '40', title: 'Done thing', url: 'https://x.test/1' });
		const lists = { last: await read(shelfTracker()), fault: null };
		const view = readFactory(root, { now: () => at, alive: () => true });
		const html = renderPanels(root, view, NO_LINKS, lists, true);
		const opener = /<button type="button" class="open" data-feature="(\d+)"/g;
		const opened = (part: string) => [...part.matchAll(opener)].map((m) => m[1]);
		const [board = '', rest = ''] = html.split('<div class="table">');
		const [table = '', overview = ''] = rest.split('<div class="overview">');
		for (const part of [board, table, overview])
			expect(opened(part).sort()).toEqual(['1', '4', '5', '6', '7']);
		expect(mat(html, 'queue')).toContain('aria-haspopup="dialog" aria-controls="feature"');
		// the title is still text, never markup
		expect(mat(html, 'shelf')).toContain('>Reports &#60;b&#62;</button>');
		// a Feature that is done opens nothing
		expect(mat(html, 'completed')).toContain('Done thing');
		expect(mat(html, 'completed')).not.toContain('data-feature');
		// without a reader for the panel, a title is plain text
		expect(renderPanels(root, view, NO_LINKS, lists)).not.toContain('data-feature');
	});
});
