// The Tracker contract (docs/adr/0001): what every Tracker Adapter must do, whether a fake, a
// built-in one or a repo's own module. Each case asks the harness for a Tracker that holds a small
// world, then drives it only through the Tracker interface.
import assert from 'node:assert/strict';
import type { Signal } from '../signals.js';
import type { Tracker } from '../tracker.js';
import type { ContractCase } from './case.js';

export interface WorldComment {
	readonly author: string;
	readonly body: string;
}

export interface WorldItem {
	// how the world names the item; the harness gives it its id
	readonly key: string;
	readonly title: string;
	// none means an empty body
	readonly body?: string;
	// open unless false
	readonly open?: boolean;
	readonly assignees?: readonly string[];
	readonly signals?: readonly Signal[];
	// its Tickets by key, in its own child order
	readonly children?: readonly string[];
	// the items that block it, by key
	readonly blockedBy?: readonly string[];
	// oldest first
	readonly comments?: readonly WorldComment[];
}

export interface TrackerWorld {
	// the signed-in person
	readonly person: string;
	// the people the Tracker trusts by its own default (on GitHub, those with write access)
	readonly trusted: readonly string[];
	// in the order they were made
	readonly items: readonly WorldItem[];
}

export interface TrackerSubject {
	readonly tracker: Tracker;
	// the id the Tracker gave the world's item `key`
	readonly id: (key: string) => number;
	// called after the case, pass or fail
	readonly close?: () => Promise<void>;
}

// Makes a Tracker that holds `world` and nothing else.
export type TrackerHarness = (world: TrackerWorld) => Promise<TrackerSubject>;

const ANN = 'ann';

function given(world: Partial<TrackerWorld>): TrackerWorld {
	return { person: ANN, trusted: [ANN], items: [], ...world };
}

function trackerCase(
	name: string,
	world: TrackerWorld,
	check: (subject: TrackerSubject) => Promise<void>
): ContractCase<TrackerHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness(world);
			try {
				await check(subject);
			} finally {
				await subject.close?.();
			}
		}
	};
}

export const trackerContract: readonly ContractCase<TrackerHarness>[] = [
	trackerCase('names the signed-in person', given({ person: 'ann' }), async ({ tracker }) => {
		assert.equal(await tracker.me(), 'ann');
	}),

	trackerCase(
		'lists the open Features assigned to a person that carry the Go, oldest first',
		given({
			items: [
				{ key: 'first', title: 'First', assignees: [ANN], signals: ['go'], children: ['a'] },
				{ key: 'theirs', title: 'Theirs', assignees: ['bob'], signals: ['go'], children: ['b'] },
				{ key: 'no-go', title: 'No Go', assignees: [ANN], signals: ['ready'], children: ['c'] },
				{
					key: 'closed',
					title: 'Closed',
					open: false,
					assignees: [ANN],
					signals: ['go'],
					children: ['d']
				},
				{
					key: 'second',
					title: 'Second',
					body: 'The spec.',
					assignees: [ANN, 'bob'],
					signals: ['go'],
					children: ['e']
				},
				...['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, title: `Ticket ${key}` }))
			]
		}),
		async ({ tracker, id }) => {
			assert.deepEqual(await tracker.assignedFeatures(ANN), [
				{ id: id('first'), title: 'First', body: '' },
				{ id: id('second'), title: 'Second', body: 'The spec.' }
			]);
			assert.deepEqual(
				(await tracker.assignedFeatures('bob')).map((f) => f.id),
				[id('theirs'), id('second')]
			);
		}
	),

	trackerCase(
		'reads a Feature with its title and body',
		given({
			items: [
				{ key: 'spec', title: 'A spec', body: 'What to build.\n\n- [ ] it works', children: ['a'] },
				{ key: 'bare', title: 'No body', children: ['a'] },
				{ key: 'a', title: 'Ticket a' }
			]
		}),
		async ({ tracker, id }) => {
			assert.deepEqual(await tracker.feature(id('spec')), {
				id: id('spec'),
				title: 'A spec',
				body: 'What to build.\n\n- [ ] it works'
			});
			assert.deepEqual(await tracker.feature(id('bare')), {
				id: id('bare'),
				title: 'No body',
				body: ''
			});
		}
	),

	trackerCase(
		"reads a Feature's Tickets in its own child order, open or closed, with their Signals",
		given({
			items: [
				{ key: 'feature', title: 'Feature', children: ['c', 'a', 'b'] },
				{ key: 'a', title: 'Ticket a', body: 'Build a.', open: false },
				{ key: 'b', title: 'Ticket b', signals: ['ready'] },
				{ key: 'c', title: 'Ticket c', body: '**Model:** opus', signals: ['needsInfo'] },
				{ key: 'other', title: 'Another Feature', children: ['d'] },
				{ key: 'd', title: 'Ticket d' }
			]
		}),
		async ({ tracker, id }) => {
			assert.deepEqual(await tracker.tickets(id('feature')), [
				{
					id: id('c'),
					title: 'Ticket c',
					body: '**Model:** opus',
					open: true,
					signals: ['needsInfo'],
					blockedBy: []
				},
				{
					id: id('a'),
					title: 'Ticket a',
					body: 'Build a.',
					open: false,
					signals: [],
					blockedBy: []
				},
				{ id: id('b'), title: 'Ticket b', body: '', open: true, signals: ['ready'], blockedBy: [] }
			]);
		}
	),

	trackerCase(
		'gives each Ticket the items that block it, open or closed, in this Feature or another',
		given({
			items: [
				{ key: 'feature', title: 'Feature', children: ['a', 'b', 'c'] },
				{ key: 'a', title: 'Ticket a' },
				{ key: 'b', title: 'Ticket b', blockedBy: ['a'] },
				{ key: 'c', title: 'Ticket c', blockedBy: ['elsewhere', 'a'] },
				{ key: 'other', title: 'Another Feature', children: ['elsewhere'] },
				{ key: 'elsewhere', title: 'Ticket elsewhere', open: false }
			]
		}),
		async ({ tracker, id }) => {
			const tickets = await tracker.tickets(id('feature'));
			assert.deepEqual(
				tickets.map((t) => ({ id: t.id, blockedBy: [...t.blockedBy].sort((x, y) => x.id - y.id) })),
				[
					{ id: id('a'), blockedBy: [] },
					{ id: id('b'), blockedBy: [{ id: id('a'), open: true }] },
					{
						id: id('c'),
						blockedBy: [
							{ id: id('a'), open: true },
							{ id: id('elsewhere'), open: false }
						].sort((x, y) => x.id - y.id)
					}
				]
			);
		}
	),

	trackerCase(
		'reads the comments on a Feature or Ticket oldest first, each trusted only if its author is',
		given({
			trusted: [ANN, 'cat'],
			items: [
				{
					key: 'feature',
					title: 'Feature',
					children: ['a', 'b'],
					comments: [
						{ author: ANN, body: 'First' },
						{ author: 'bob', body: 'Second' },
						{ author: 'cat', body: 'Third' },
						{ author: ANN, body: 'Fourth' }
					]
				},
				{ key: 'a', title: 'Ticket a', comments: [{ author: 'bob', body: 'Do it my way.' }] },
				{ key: 'b', title: 'Ticket b' }
			]
		}),
		async ({ tracker, id }) => {
			const onFeature = await tracker.comments(id('feature'));
			assert.deepEqual(
				onFeature.map((c) => [c.author, c.body, c.trusted]),
				[
					[ANN, 'First', true],
					['bob', 'Second', false],
					['cat', 'Third', true],
					[ANN, 'Fourth', true]
				]
			);
			const times = onFeature.map((c) => Date.parse(c.at));
			assert.ok(
				times.every((t, i) => !Number.isNaN(t) && t >= (times[i - 1] ?? t)),
				`each comment's time is a date, none before the one above it: ${onFeature.map((c) => c.at).join(', ')}`
			);
			assert.deepEqual(
				(await tracker.comments(id('a'))).map((c) => [c.author, c.body, c.trusted]),
				[['bob', 'Do it my way.', false]]
			);
			assert.deepEqual(await tracker.comments(id('b')), []);
		}
	)
];
