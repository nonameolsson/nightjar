// The statusNote contract (docs/custom-adapters.md, docs/adr/0012): run over a Tracker that has the optional method.
import assert from 'node:assert/strict';
import { FOOTER } from '../footer.js';
import { STATUS_MARKER, statusNoteOf, type ItemId, type Tracker } from '../tracker.js';
import type { ContractCase } from './case.js';
import type { TrackerHarness, TrackerSubject, TrackerWorld } from './tracker.js';

// the signed-in person, whose name `me` gives
const ANN = 'ann';
const BOB = 'bob';

type Noting = Omit<TrackerSubject, 'tracker'> & {
	readonly tracker: Tracker & { statusNote: (id: ItemId, body: string) => Promise<void> };
};

function noteCase(
	name: string,
	items: TrackerWorld['items'],
	check: (subject: Noting) => Promise<void>
): ContractCase<TrackerHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness({ person: ANN, trusted: [ANN], items });
			try {
				const { tracker } = subject;
				assert.ok(tracker.statusNote !== undefined, 'the Tracker has statusNote');
				await check({ ...subject, tracker: tracker as Noting['tracker'] });
			} finally {
				await subject.close?.();
			}
		}
	};
}

// A Status note as Nightjar writes one: the marker first, the footer last, and text a Tracker must keep as it is between them.
const note = (state: string) =>
	`${STATUS_MARKER}\n**${state}**: Nightjar is on it.\n\n- #1 "first" \`$(rm -rf /)\` @here & <b>this</b>${FOOTER}`;

type Comments = TrackerWorld['items'][number]['comments'];

// a Feature with one Ticket, so it is a Feature on every Tracker, and the comments on it
const feature = (comments: Comments = []): TrackerWorld['items'] => [
	{ key: 'feature', title: 'Feature', assignees: [ANN], children: ['a'], comments },
	{ key: 'a', title: 'Ticket a' }
];

// each comment on the item by its author and body, oldest first
async function said(tracker: Tracker, id: ItemId): Promise<string[][]> {
	const comments = await tracker.comments(id);
	return comments.map((c) => [c.author, c.body]);
}

export const statusNoteContract: readonly ContractCase<TrackerHarness>[] = [
	noteCase(
		'makes the Status note as one comment by the signed-in person, below those already there, found again by its marker',
		feature([{ author: BOB, body: 'Before.' }]),
		async ({ tracker, id }) => {
			await tracker.statusNote(id('feature'), note('Building'));
			assert.deepEqual(await said(tracker, id('feature')), [
				[BOB, 'Before.'],
				[ANN, note('Building')]
			]);
			assert.equal(
				statusNoteOf(await tracker.comments(id('feature')), ANN)?.body,
				note('Building'),
				'the note is found among the comments by its marker'
			);
		}
	),

	noteCase(
		'edits that same comment on a second call, so there is still one note',
		feature(),
		async ({ tracker, id }) => {
			await tracker.statusNote(id('feature'), note('Building'));
			const made = (await tracker.comments(id('feature')))[0]?.at;
			await tracker.statusNote(id('feature'), note('Draft PR open'));
			assert.deepEqual(await said(tracker, id('feature')), [[ANN, note('Draft PR open')]]);
			const after = (await tracker.comments(id('feature')))[0]?.at;
			assert.equal(after, made, 'the edited note keeps when it was made');
		}
	),

	noteCase(
		"edits the note in its place and leaves a person's comment after it untouched",
		feature([
			{ author: ANN, body: 'A comment of my own.' },
			{ author: ANN, body: note('Building') },
			{ author: BOB, body: 'In between.' }
		]),
		async ({ tracker, id }) => {
			await tracker.statusNote(id('feature'), note('Draft PR open'));
			await tracker.statusNote(id('feature'), note('Stopped'));
			assert.deepEqual(await said(tracker, id('feature')), [
				[ANN, 'A comment of my own.'],
				[ANN, note('Stopped')],
				[BOB, 'In between.']
			]);
		}
	),

	noteCase(
		'never takes a comment by anyone else as the note, even one that opens with the marker',
		feature([{ author: BOB, body: note('Copied') }]),
		async ({ tracker, id }) => {
			await tracker.statusNote(id('feature'), note('Building'));
			await tracker.statusNote(id('feature'), note('Draft PR open'));
			assert.deepEqual(await said(tracker, id('feature')), [
				[BOB, note('Copied')],
				[ANN, note('Draft PR open')]
			]);
		}
	),

	noteCase(
		"keeps each item's note on that item",
		[
			...feature(),
			{ key: 'lone', title: 'Lone', assignees: [ANN], signals: ['go'] },
			{ key: 'other', title: 'Other', assignees: [ANN], children: ['b'] },
			{ key: 'b', title: 'Ticket b' }
		],
		async ({ tracker, id }) => {
			await tracker.statusNote(id('feature'), note('Building'));
			await tracker.statusNote(id('lone'), note('Paused'));
			await tracker.statusNote(id('feature'), note('Draft PR open'));
			assert.deepEqual(await said(tracker, id('feature')), [[ANN, note('Draft PR open')]]);
			assert.deepEqual(await said(tracker, id('lone')), [[ANN, note('Paused')]]);
			assert.deepEqual(await tracker.comments(id('other')), []);
		}
	)
];
