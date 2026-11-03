// The waitingOn contract (docs/custom-adapters.md): run over a Tracker that has the optional method.
import assert from 'node:assert/strict';
import type { Tracker, WaitingFeature } from '../tracker.js';
import type { ContractCase } from './case.js';
import type { TrackerHarness, TrackerSubject, TrackerWorld } from './tracker.js';

const ANN = 'ann';

type Listing = Omit<TrackerSubject, 'tracker'> & {
	readonly tracker: Tracker & { waitingOn: (person: string) => Promise<WaitingFeature[]> };
};

function waitingCase(
	name: string,
	items: TrackerWorld['items'],
	check: (subject: Listing) => Promise<void>
): ContractCase<TrackerHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness({ person: ANN, trusted: [ANN], items });
			try {
				const { tracker } = subject;
				assert.ok(tracker.waitingOn !== undefined, 'the Tracker has waitingOn');
				await check({ ...subject, tracker: tracker as Listing['tracker'] });
			} finally {
				await subject.close?.();
			}
		}
	};
}

export const waitingOnContract: readonly ContractCase<TrackerHarness>[] = [
	waitingCase(
		'lists the open Features assigned to a person that carry needs info or needs a person, oldest first',
		[
			{ key: 'asks', title: 'Asks', assignees: [ANN], signals: ['needsInfo'], children: ['a'] },
			{
				key: 'theirs',
				title: 'Theirs',
				assignees: ['bob'],
				signals: ['needsInfo'],
				children: ['b']
			},
			{
				key: 'building',
				title: 'Building',
				assignees: [ANN],
				signals: ['working'],
				children: ['c']
			},
			{ key: 'go', title: 'Go only', assignees: [ANN], signals: ['go'], children: ['d'] },
			{
				key: 'closed',
				title: 'Closed',
				open: false,
				assignees: [ANN],
				signals: ['needsInfo'],
				children: ['e']
			},
			// carries both Signals, and is listed once
			{
				key: 'both',
				title: 'Both',
				body: 'The spec.',
				assignees: [ANN],
				signals: ['needsInfo', 'human'],
				children: ['f']
			},
			{ key: 'person', title: 'Person', assignees: [ANN], signals: ['human'], children: ['g'] },
			// a Ticket that waits is no Feature
			{ key: 'a', title: 'Ticket a', assignees: [ANN], signals: ['needsInfo'] },
			...['b', 'c', 'd', 'e', 'f', 'g'].map((key) => ({ key, title: `Ticket ${key}` }))
		],
		async ({ tracker, id }) => {
			assert.deepEqual(await tracker.waitingOn(ANN), [
				{ id: id('asks'), title: 'Asks', body: '', signal: 'needsInfo' },
				// with both Signals needs info wins: the person has a question to answer
				{ id: id('both'), title: 'Both', body: 'The spec.', signal: 'needsInfo' },
				{ id: id('person'), title: 'Person', body: '', signal: 'human' }
			]);
			assert.deepEqual(
				(await tracker.waitingOn('bob')).map((f) => f.id),
				[id('theirs')]
			);
		}
	),

	waitingCase(
		'follows the Signals on the Feature as they are added and taken off',
		[
			{ key: 'feature', title: 'Feature', assignees: [ANN], children: ['a'] },
			{ key: 'a', title: 'Ticket a' }
		],
		async ({ tracker, id }) => {
			const listed = async () => (await tracker.waitingOn(ANN)).map((f) => f.id);
			assert.deepEqual(await listed(), []);
			await tracker.addSignal(id('feature'), 'needsInfo');
			assert.deepEqual(await listed(), [id('feature')]);
			await tracker.removeSignal(id('feature'), 'needsInfo');
			assert.deepEqual(await listed(), []);
			await tracker.addSignal(id('feature'), 'human');
			assert.deepEqual(await listed(), [id('feature')]);
		}
	)
];
