// The ticketCounts contract (docs/custom-adapters.md): run over a Tracker that has the optional method.
import assert from 'node:assert/strict';
import type { ItemId, TicketCount, Tracker } from '../tracker.js';
import type { ContractCase } from './case.js';
import type { TrackerHarness, TrackerSubject, TrackerWorld } from './tracker.js';

const ANN = 'ann';

// no item of any world has this id
const NO_SUCH = '987654';

type Counting = Omit<TrackerSubject, 'tracker'> & {
	readonly tracker: Tracker & {
		ticketCounts: (ids: readonly ItemId[]) => Promise<Map<ItemId, TicketCount | null>>;
	};
};

function countCase(
	name: string,
	items: TrackerWorld['items'],
	check: (subject: Counting) => Promise<void>
): ContractCase<TrackerHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness({ person: ANN, trusted: [ANN], items });
			try {
				const { tracker } = subject;
				assert.ok(tracker.ticketCounts !== undefined, 'the Tracker has ticketCounts');
				await check({ ...subject, tracker: tracker as Counting['tracker'] });
			} finally {
				await subject.close?.();
			}
		}
	};
}

const WORLD: TrackerWorld['items'] = [
	{ key: 'mixed', title: 'Mixed', assignees: [ANN], signals: ['go'], children: ['a', 'b', 'c'] },
	{ key: 'fresh', title: 'Fresh', assignees: [ANN], signals: ['go'], children: ['d'] },
	{ key: 'done', title: 'Done', assignees: [ANN], signals: ['human'], children: ['e', 'f'] },
	{ key: 'a', title: 'Ticket a', open: false },
	{ key: 'b', title: 'Ticket b' },
	{ key: 'c', title: 'Ticket c', open: false },
	{ key: 'd', title: 'Ticket d' },
	{ key: 'e', title: 'Ticket e', open: false },
	{ key: 'f', title: 'Ticket f', open: false }
];

export const ticketCountsContract: readonly ContractCase<TrackerHarness>[] = [
	countCase(
		'counts the Tickets of each Feature asked about and how many are closed',
		WORLD,
		async ({ tracker, id }) => {
			const got = await tracker.ticketCounts([id('mixed'), id('fresh'), id('done')]);
			assert.equal(got.size, 3);
			assert.deepEqual(got.get(id('mixed')), { total: 3, closed: 2 });
			assert.deepEqual(got.get(id('fresh')), { total: 1, closed: 0 });
			assert.deepEqual(got.get(id('done')), { total: 2, closed: 2 });
		}
	),

	countCase(
		'counts a Feature the same after the Tracker has listed it',
		WORLD,
		async ({ tracker, id }) => {
			await tracker.assignedFeatures(ANN);
			await tracker.waitingOn?.(ANN);
			const got = await tracker.ticketCounts([id('done'), id('mixed')]);
			assert.deepEqual(got.get(id('mixed')), { total: 3, closed: 2 });
			assert.deepEqual(got.get(id('done')), { total: 2, closed: 2 });
		}
	),

	countCase(
		'answers every Feature asked about, with null for one whose count cannot be read',
		WORLD,
		async ({ tracker, id }) => {
			const asked = [id('fresh'), NO_SUCH, id('mixed')];
			const got = await tracker.ticketCounts(asked);
			assert.deepEqual([...got.keys()].sort(), [...asked].sort(), 'every id is answered');
			assert.equal(got.get(NO_SUCH), null);
			assert.deepEqual(got.get(id('fresh')), { total: 1, closed: 0 });
			assert.deepEqual(got.get(id('mixed')), { total: 3, closed: 2 });
		}
	),

	countCase('answers no Features with no counts', WORLD, async ({ tracker }) => {
		assert.equal((await tracker.ticketCounts([])).size, 0);
	})
];
