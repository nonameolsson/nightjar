// The assign contract (docs/custom-adapters.md): run over a Tracker that has the optional method, by which a `go: true` Source gives the Go in its owner's name.
import assert from 'node:assert/strict';
import type { ItemId, Tracker } from '../tracker.js';
import type { ContractCase } from './case.js';
import type { TrackerHarness, TrackerSubject, TrackerWorld } from './tracker.js';

const ANN = 'ann';
const CAT = 'cat';

type Assigning = Omit<TrackerSubject, 'tracker'> & {
	readonly tracker: Tracker & { assign: (id: ItemId, person: string) => Promise<void> };
};

function assignCase(
	name: string,
	world: Omit<TrackerWorld, 'person'>,
	check: (subject: Assigning) => Promise<void>
): ContractCase<TrackerHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness({ person: ANN, ...world });
			try {
				const { tracker } = subject;
				assert.ok(tracker.assign !== undefined, 'the Tracker has assign');
				await check({ ...subject, tracker: tracker as Assigning['tracker'] });
			} finally {
				await subject.close?.();
			}
		}
	};
}

// a Feature assigned to no one and carrying no Signal, as a Source makes it, with one Ticket so that it is a Feature on every Tracker
const unassigned: TrackerWorld['items'] = [
	{ key: 'made', title: 'Made by a Source', body: 'An event.', children: ['made-ticket'] },
	{ key: 'made-ticket', title: 'Ticket of the Feature' }
];

export const assignContract: readonly ContractCase<TrackerHarness>[] = [
	assignCase(
		'assigns a Feature to a person, so that with the Go it is among their assigned Features',
		{ trusted: [ANN], items: unassigned },
		async ({ tracker, id }) => {
			await tracker.assign(id('made'), ANN);
			assert.deepEqual((await tracker.standing(id('made'))).assignees, [ANN]);
			assert.deepEqual(await tracker.assignedFeatures(ANN), []);
			await tracker.addSignal(id('made'), 'go');
			assert.deepEqual(
				(await tracker.assignedFeatures(ANN)).map((f) => f.id),
				[id('made')]
			);
		}
	),

	assignCase(
		'says whom it trusts by its own default, and that it trusts no one else',
		{ trusted: [ANN, CAT], items: unassigned },
		async ({ tracker }) => {
			// a Tracker without trusts leaves the owner to factory.json's trusted list
			if (tracker.trusts === undefined) return;
			assert.equal(await tracker.trusts(ANN), true, `${ANN} is trusted`);
			assert.equal(await tracker.trusts(CAT), true, `${CAT} is trusted`);
			assert.equal(await tracker.trusts('dan'), false, 'dan is not trusted');
		}
	)
];
