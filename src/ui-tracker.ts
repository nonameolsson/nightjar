// `nightjar ui`'s own read of the Tracker (docs/adr/0009): the Queue, Waiting on you and the Shelf, read-only, so all are known while Nightjar is off; and one Feature for its detail panel.
import { makeAdapters, type Seams } from './adapters.js';
import { loadConfig } from './config.js';
import { checkTickets, type TicketChecks } from './feature-faults.js';
import type { Env } from './git.js';
import { loadPersonConfig } from './person-config.js';
import { buildOrder, NEEDS_A_PERSON, NEEDS_INFO } from './plan.js';
import { why } from './say.js';
import type { Queued, TicketCounts, WaitingItem } from './status-shape.js';
import {
	SHELF_MAX,
	type Feature,
	type ItemId,
	type Shelf,
	type Ticket,
	type Tracker,
	type WaitingFeature
} from './tracker.js';

// how often the page reads the Tracker again; a change under .factory/ never reads it
export const TRACKER_EVERY_MS = 60_000;

// The Tracker as the page holds it: reads only, so the page can give no Signal, assign no one and write no comment (docs/adr/0003).
export type ReadingTracker = Pick<
	Tracker,
	'assignedFeatures' | 'waitingOn' | 'ticketCounts' | 'shelf'
>;

// The reads the Feature detail panel makes of one Feature, when it opens.
export type FeatureReader = Pick<Tracker, 'feature' | 'tickets' | 'reference'>;

export interface PageTracker<T = ReadingTracker> {
	readonly tracker: T;
	// whose Features the page shows: config.json's assignee, else the person signed in to the Tracker, as a run builds for
	readonly person: string;
}

// What one read of the Tracker gave.
export interface Upcoming {
	// the Features with the Go, oldest first
	readonly queue: readonly Queued[];
	// the Features that carry needs info or needs a person
	readonly waiting: readonly WaitingItem[];
	// true when the Tracker has no waitingOn, so `waiting` is empty
	readonly trackerCannotList: boolean;
	// the person's Shelf, at most SHELF_MAX Features, newest update first; null when the Tracker has no `shelf`
	readonly shelf: Shelf | null;
	// whose Features these are; the link to the rest of the Shelf on the Tracker names them
	readonly person: string;
	// when it was read, as an ISO date
	readonly at: string;
}

// Why the last read failed, and when.
export interface ReadFault {
	readonly at: string;
	readonly why: string;
}

// What the page knows of the Tracker: the last lists read, kept when a later read fails.
export interface TrackerLists {
	// null until a read has gone well
	readonly last: Upcoming | null;
	// null when the last read went well
	readonly fault: ReadFault | null;
}

// A Feature that waits on the person, in the words the run writes to status.json.
const waitingItem = (f: WaitingFeature): WaitingItem => ({
	kind: 'feature',
	id: f.id,
	title: f.title,
	why: f.signal === 'needsInfo' ? NEEDS_INFO : NEEDS_A_PERSON
});

// One read of the lists. Ticket counts are a nicety: a fault there leaves each count unknown, never the lists unread.
export async function readUpcoming(page: PageTracker, now: () => Date): Promise<Upcoming> {
	const { tracker, person } = page;
	const [features, waitingOn, shelf] = await Promise.all([
		tracker.assignedFeatures(person),
		tracker.waitingOn?.(person),
		tracker.shelf?.(person, SHELF_MAX)
	]);
	const waiting = (waitingOn ?? []).map(waitingItem);
	const queue = features.map((f): Queued => ({ id: f.id, title: f.title }));
	const counts = await countsOf(tracker, [...queue, ...waiting]);
	// left out when the Tracker cannot count, as the run writes it
	const withCount = <T extends { readonly id: ItemId }>(item: T): T =>
		counts === null ? item : { ...item, ticketCounts: counts.get(item.id) ?? null };
	return {
		queue: queue.map(withCount),
		waiting: waiting.map(withCount),
		trackerCannotList: tracker.waitingOn === undefined,
		shelf: shelf ?? null,
		person,
		at: now().toISOString()
	};
}

// The Ticket count of each Feature, null for one that could not be read; null in all when the Tracker cannot count.
async function countsOf(
	tracker: ReadingTracker,
	items: readonly { readonly id: ItemId }[]
): Promise<Map<ItemId, TicketCounts | null> | null> {
	if (tracker.ticketCounts === undefined) return null;
	const ids = [...new Set(items.map((i) => i.id))];
	try {
		return await tracker.ticketCounts(ids);
	} catch {
		return new Map();
	}
}

// Opens the Tracker on the first call and again after a call that could not open it, so the lists and the Feature detail panel share one.
export function openOnce<P>(open: () => Promise<P>): () => Promise<P> {
	let opened: Promise<P> | null = null;
	return async () => {
		opened ??= open();
		try {
			return await opened;
		} catch (fault) {
			// gh signed out, or factory.json being edited: the next read tries again
			opened = null;
			throw fault;
		}
	};
}

// Reads the lists, opening the Tracker on the first read and again after a read that could not open it.
export function listsFrom(
	open: () => Promise<PageTracker>,
	now: () => Date = () => new Date()
): () => Promise<Upcoming> {
	const page = openOnce(open);
	return async () => readUpcoming(await page(), now);
}

// A Feature as its detail panel shows it.
export interface FeatureDetail {
	readonly feature: Feature;
	// open and closed, in Build order; a lone issue's one Ticket is itself
	readonly tickets: readonly Ticket[];
	// the Ticket contract check of its open Tickets, the one `nightjar doctor` runs
	readonly checks: TicketChecks;
}

// One read of a Feature and its Tickets, put in Build order as src/plan.ts orders them, and checked against the Ticket contract.
// `workflows` are the names of the Workflows factory.json defines.
export async function readFeature(
	tracker: FeatureReader,
	id: ItemId,
	workflows: readonly string[]
): Promise<FeatureDetail> {
	const [feature, tickets] = await Promise.all([tracker.feature(id), tracker.tickets(id)]);
	const checks = checkTickets(feature, tickets, workflows, (i) => tracker.reference(i).text);
	return { feature, tickets: buildOrder(tickets), checks };
}

// A page's Tracker with the Workflows factory.json names, which the Ticket contract check holds a Feature's Workflow line against.
export interface DetailTracker extends PageTracker<FeatureReader> {
	readonly workflows: readonly string[];
}

// Reads one Feature for its detail panel, when the panel opens, through the Tracker the lists read.
export function detailFrom(
	open: () => Promise<DetailTracker>
): (id: ItemId) => Promise<FeatureDetail> {
	const page = openOnce(open);
	return async (id) => {
		const { tracker, workflows } = await page();
		return readFeature(tracker, id, workflows);
	};
}

// The Tracker factory.json names, built as a run builds it, and the person a run would build for.
export async function openPageTracker(
	root: string,
	env: Env,
	seams: Seams
): Promise<PageTracker<ReadingTracker & FeatureReader> & DetailTracker> {
	const config = loadConfig(root);
	const { tracker } = await makeAdapters(config, root, env, seams);
	const person = loadPersonConfig(env).assignee ?? (await tracker.me());
	return { tracker, person, workflows: Object.keys(config.workflows ?? {}) };
}

export interface WatchOptions {
	readonly read: () => Promise<Upcoming>;
	// told after each read, whether it went well or not
	readonly changed: () => void;
	// calls `tick` every `ms` and gives back how to stop; setInterval unless a spec passes its own
	readonly every?: (ms: number, tick: () => void) => () => void;
	readonly now?: () => Date;
}

export interface TrackerWatch {
	// what the page knows of the Tracker now
	readonly lists: () => TrackerLists;
	// the read in flight, done at once when there is none
	readonly reading: () => Promise<void>;
	readonly stop: () => void;
}

const everyMs = (ms: number, tick: () => void) => {
	const timer = setInterval(tick, ms);
	return () => clearInterval(timer);
};

// Reads the lists at once and every TRACKER_EVERY_MS, one read at a time; a failed read keeps the last lists and says why.
export function watchTracker(o: WatchOptions): TrackerWatch {
	const now = o.now ?? (() => new Date());
	let lists: TrackerLists = { last: null, fault: null };
	let inFlight: Promise<void> | null = null;
	let stopped = false;
	const tick = () => {
		if (inFlight !== null || stopped) return;
		inFlight = Promise.resolve()
			.then(() => o.read())
			.then(
				(last) => {
					lists = { last, fault: null };
				},
				(fault: unknown) => {
					lists = { last: lists.last, fault: { at: now().toISOString(), why: why(fault) } };
				}
			)
			.then(() => {
				inFlight = null;
				if (!stopped) o.changed();
			});
	};
	tick();
	const stopTicks = (o.every ?? everyMs)(TRACKER_EVERY_MS, tick);
	return {
		lists: () => lists,
		reading: () => inFlight ?? Promise.resolve(),
		stop: () => {
			stopped = true;
			stopTicks();
		}
	};
}
