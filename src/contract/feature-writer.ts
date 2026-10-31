// The creation contract (docs/ticket-contract.md): what a Tracker that also makes Features and Tickets
// must do. What it makes is read back through the Tracker's own methods, as a build would read it.
import assert from 'node:assert/strict';
import { canCreate, type FeatureWriter, type Tracker } from '../tracker.js';
import type { ContractCase } from './case.js';
import type { TrackerHarness, TrackerSubject, TrackerWorld } from './tracker.js';

const ANN = 'ann';

type Writing = Omit<TrackerSubject, 'tracker'> & { readonly tracker: Tracker & FeatureWriter };

function writerCase(
	name: string,
	items: TrackerWorld['items'],
	check: (subject: Writing) => Promise<void>
): ContractCase<TrackerHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness({ person: ANN, trusted: [ANN], items });
			try {
				const { tracker } = subject;
				assert.ok(canCreate(tracker), 'the Tracker has createFeature, createTicket and block');
				await check({ ...subject, tracker });
			} finally {
				await subject.close?.();
			}
		}
	};
}

// A Ticket in the contract's shape, with what a person might type in it.
const TICKET_BODY = [
	'**Model:** opus',
	'**Effort:** high',
	'',
	'Share the escape with `escapeHtml(text)` & keep <b>bold</b> as text.',
	'',
	'## Acceptance criteria',
	'',
	'- [ ] one escape for both',
	'- [ ] a "quoted" value stays quoted'
].join('\n');

export const featureWriterContract: readonly ContractCase<TrackerHarness>[] = [
	writerCase(
		'makes a Feature with its title and body, and each Ticket its last child, in the order made',
		[
			{ key: 'other', title: 'Another Feature', children: ['old'] },
			{ key: 'old', title: 'An older Ticket' }
		],
		async ({ tracker, id }) => {
			const feature = await tracker.createFeature({
				title: 'Share the escape',
				body: 'The spec.\n\n## Solution\n\nOne escape.'
			});
			const made: string[] = [];
			for (const title of ['First', 'Second', 'Third']) {
				made.push(await tracker.createTicket(feature, { title, body: `Build ${title}.` }));
			}
			assert.equal(new Set([feature, ...made, id('other'), id('old')]).size, 6, 'each id is new');
			assert.deepEqual(await tracker.feature(feature), {
				id: feature,
				title: 'Share the escape',
				body: 'The spec.\n\n## Solution\n\nOne escape.'
			});
			assert.deepEqual(
				await tracker.tickets(feature),
				['First', 'Second', 'Third'].map((title, i) => ({
					id: made[i],
					title,
					body: `Build ${title}.`,
					open: true,
					signals: [],
					blockedBy: []
				}))
			);
			assert.deepEqual(
				(await tracker.tickets(id('other'))).map((t) => t.id),
				[id('old')]
			);
		}
	),

	writerCase(
		"keeps a Ticket's body as written, so its Model and Effort lines and acceptance criteria read back",
		[],
		async ({ tracker }) => {
			const feature = await tracker.createFeature({ title: 'Feature', body: 'The spec.' });
			await tracker.createTicket(feature, { title: 'Ticket', body: TICKET_BODY });
			assert.deepEqual(
				(await tracker.tickets(feature)).map((t) => t.body),
				[TICKET_BODY]
			);
		}
	),

	writerCase(
		'links a Ticket as blocked by another it made, or by an item already there',
		[
			{ key: 'other', title: 'Another Feature', children: ['done'] },
			{ key: 'done', title: 'A closed Ticket', open: false }
		],
		async ({ tracker, id }) => {
			const feature = await tracker.createFeature({ title: 'Feature', body: '' });
			const a = await tracker.createTicket(feature, { title: 'a', body: 'Build a.' });
			const b = await tracker.createTicket(feature, { title: 'b', body: 'Build b.' });
			const c = await tracker.createTicket(feature, { title: 'c', body: 'Build c.' });
			await tracker.block(b, a);
			await tracker.block(c, a);
			await tracker.block(c, id('done'));
			const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id);
			assert.deepEqual(
				(await tracker.tickets(feature)).map((t) => ({
					id: t.id,
					blockedBy: [...t.blockedBy].sort(byId)
				})),
				[
					{ id: a, blockedBy: [] },
					{ id: b, blockedBy: [{ id: a, open: true }] },
					{
						id: c,
						blockedBy: [
							{ id: a, open: true },
							{ id: id('done'), open: false }
						].sort(byId)
					}
				]
			);
		}
	),

	writerCase('takes a Signal on a Ticket it made', [], async ({ tracker }) => {
		const feature = await tracker.createFeature({ title: 'Feature', body: 'The spec.' });
		const ticket = await tracker.createTicket(feature, { title: 'Ticket', body: 'Build it.' });
		await tracker.addSignal(ticket, 'ready');
		assert.deepEqual(
			(await tracker.tickets(feature)).map((t) => t.signals),
			[['ready']]
		);
	})
];
