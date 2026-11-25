// The shelf contract (docs/custom-adapters.md): run over a Tracker that has the optional method.
import assert from 'node:assert/strict';
import { SHELF_MAX, type ItemId, type Shelf, type Tracker } from '../tracker.js';
import type { ContractCase } from './case.js';
import type { TrackerHarness, TrackerSubject, TrackerWorld } from './tracker.js';

const ANN = 'ann';

type Shelving = Omit<TrackerSubject, 'tracker'> & {
	readonly tracker: Tracker & { shelf: (person: string, max: number) => Promise<Shelf> };
};

function shelfCase(
	name: string,
	items: TrackerWorld['items'],
	check: (subject: Shelving) => Promise<void>
): ContractCase<TrackerHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness({ person: ANN, trusted: [ANN], items });
			try {
				const { tracker } = subject;
				assert.ok(tracker.shelf !== undefined, 'the Tracker has shelf');
				await check({ ...subject, tracker: tracker as Shelving['tracker'] });
			} finally {
				await subject.close?.();
			}
		}
	};
}

// a Feature of the world assigned to `assignees`, with one open Ticket so that it is a Feature on every Tracker
const feature = (
	key: string,
	more: Partial<TrackerWorld['items'][number]> = {}
): TrackerWorld['items'] => [
	{ key, title: `Feature ${key}`, assignees: [ANN], children: [`${key}-ticket`], ...more },
	{ key: `${key}-ticket`, title: `Ticket of ${key}` }
];

// A change to the item and back, so it is the one updated last; a Signal is a change every Tracker keeps.
async function touch(tracker: Tracker, id: ItemId): Promise<void> {
	await tracker.addSignal(id, 'human');
	await tracker.removeSignal(id, 'human');
}

const byId = (a: { id: ItemId }, b: { id: ItemId }) =>
	a.id.localeCompare(b.id, 'en', { numeric: true });

// what the Shelf lists, without when each was updated, in id order
const listed = (shelf: Shelf) =>
	shelf.features.map(({ updated: _updated, ...rest }) => rest).sort(byId);

const order = (shelf: Shelf) => shelf.features.map((f) => f.id);

export const shelfContract: readonly ContractCase<TrackerHarness>[] = [
	shelfCase(
		'lists the open Features assigned to a person that carry no Signal, each saying whether it has Tickets',
		[
			...feature('plain', { body: 'The spec.' }),
			// a Feature whose Tickets are all closed still has Tickets
			{ key: 'emptied', title: 'Emptied', assignees: [ANN], children: ['done'] },
			{ key: 'done', title: 'Done', open: false },
			...feature('go', { signals: ['go'] }),
			...feature('ready', { signals: ['ready'] }),
			...feature('working', { signals: ['working'] }),
			...feature('asks', { signals: ['needsInfo'] }),
			...feature('person', { signals: ['human'] }),
			...feature('theirs', { assignees: ['bob'] }),
			...feature('nobody', { assignees: [] }),
			...feature('closed', { open: false }),
			// a Ticket assigned to the person is no Feature of theirs
			{ key: 'owner', title: 'Owner', children: ['owned'] },
			{ key: 'owned', title: 'Owned', assignees: [ANN] }
		],
		async ({ tracker, id }) => {
			const shelf = await tracker.shelf(ANN, SHELF_MAX);
			assert.deepEqual(
				listed(shelf),
				[
					{ id: id('plain'), title: 'Feature plain', body: 'The spec.', hasTickets: true },
					{ id: id('emptied'), title: 'Emptied', body: '', hasTickets: true }
				].sort(byId)
			);
			assert.equal(shelf.total, 2);
			const times = shelf.features.map((f) => Date.parse(f.updated));
			assert.ok(
				times.every((t, i) => !Number.isNaN(t) && t <= (times[i - 1] ?? t)),
				`each Feature's time is a date, none after the one above it: ${shelf.features.map((f) => f.updated).join(', ')}`
			);
			assert.deepEqual(order(await tracker.shelf('bob', SHELF_MAX)), [id('theirs')]);
		}
	),

	shelfCase(
		'puts the Feature updated last first',
		[...feature('first'), ...feature('second'), ...feature('third')],
		async ({ tracker, id }) => {
			for (const key of ['second', 'third', 'first']) await touch(tracker, id(key));
			assert.deepEqual(order(await tracker.shelf(ANN, SHELF_MAX)), [
				id('first'),
				id('third'),
				id('second')
			]);
			await touch(tracker, id('second'));
			assert.deepEqual(order(await tracker.shelf(ANN, SHELF_MAX)), [
				id('second'),
				id('first'),
				id('third')
			]);
		}
	),

	shelfCase(
		'lists no more Features than it is asked for, those updated last, and counts them all',
		['a', 'b', 'c', 'd', 'e'].flatMap((key) => feature(key)),
		async ({ tracker, id }) => {
			for (const key of ['a', 'b', 'c', 'd', 'e']) await touch(tracker, id(key));
			const two = await tracker.shelf(ANN, 2);
			assert.deepEqual(order(two), [id('e'), id('d')]);
			assert.equal(two.total, 5);
			const all = await tracker.shelf(ANN, SHELF_MAX);
			assert.deepEqual(order(all), [id('e'), id('d'), id('c'), id('b'), id('a')]);
			assert.equal(all.total, 5);
		}
	),

	shelfCase(
		'takes a Feature off the Shelf while it carries a Signal',
		[...feature('feature'), ...feature('other')],
		async ({ tracker, id }) => {
			const shelved = async () => (await tracker.shelf(ANN, SHELF_MAX)).features.map((f) => f.id);
			await tracker.addSignal(id('feature'), 'go');
			assert.deepEqual(await shelved(), [id('other')]);
			await tracker.removeSignal(id('feature'), 'go');
			assert.deepEqual((await shelved()).sort(), [id('feature'), id('other')].sort());
			await tracker.addSignal(id('other'), 'needsInfo');
			assert.deepEqual(await shelved(), [id('feature')]);
		}
	),

	shelfCase(
		'lists no Features for a person with none, and counts none',
		[],
		async ({ tracker }) => {
			assert.deepEqual(await tracker.shelf(ANN, SHELF_MAX), { features: [], total: 0 });
		}
	),

	shelfCase(
		'lists an issue with no Tickets as a lone issue, when the Tracker builds lone issues',
		[
			{ key: 'lone', title: 'Lone', body: 'Do it.', assignees: [ANN] },
			{ key: 'given', title: 'Given the Go', assignees: [ANN], signals: ['go'] },
			{ key: 'theirs', title: 'Theirs', assignees: ['bob'] }
		],
		async ({ tracker, id }) => {
			if (tracker.loneIssues !== true) return;
			assert.deepEqual(listed(await tracker.shelf(ANN, SHELF_MAX)), [
				{ id: id('lone'), title: 'Lone', body: 'Do it.', lone: true, hasTickets: false }
			]);
		}
	)
];
