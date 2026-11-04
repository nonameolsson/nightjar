// The featuresFrom contract (docs/custom-adapters.md): run over a Tracker that has the optional method.
import assert from 'node:assert/strict';
import { sourceMarker } from '../template.js';
import { canCreate, type SourcedFeature, type Tracker } from '../tracker.js';
import type { ContractCase } from './case.js';
import type { TrackerHarness, TrackerSubject, TrackerWorld } from './tracker.js';

const ANN = 'ann';

type Finding = Omit<TrackerSubject, 'tracker'> & {
	readonly tracker: Tracker & { featuresFrom: (source: string) => Promise<SourcedFeature[]> };
};

function sourcesCase(
	name: string,
	items: TrackerWorld['items'],
	check: (subject: Finding) => Promise<void>
): ContractCase<TrackerHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness({ person: ANN, trusted: [ANN], items });
			try {
				const { tracker } = subject;
				assert.ok(tracker.featuresFrom !== undefined, 'the Tracker has featuresFrom');
				await check({ ...subject, tracker: tracker as Finding['tracker'] });
			} finally {
				await subject.close?.();
			}
		}
	};
}

const marked = (source: string, key: string, text = 'An event.') =>
	`${text}\n\n**Source:** ${source}\n${sourceMarker(source, key)}`;

// a Feature of the world, with one Ticket so that it is a Feature on every Tracker
const feature = (
	key: string,
	body: string,
	more: { readonly open?: boolean } = {}
): TrackerWorld['items'] => [
	{ key, title: `Feature ${key}`, body, ...more, children: [`${key}-ticket`] },
	{ key: `${key}-ticket`, title: `Ticket of ${key}` }
];

export const sourcesContract: readonly ContractCase<TrackerHarness>[] = [
	sourcesCase(
		"finds the Features that carry a Source's marker, open or closed, with their key, oldest first",
		[
			...feature('first', marked('sentry', 'issue-1')),
			...feature('other', marked('weekly-deps', 'issue-1')),
			...feature('plain', 'A Feature with no marker.'),
			...feature('closed', marked('sentry', 'issue-2'), { open: false }),
			...feature('keyless', marked('sentry', '')),
			// the first marker is the Source's own: one the payload quotes later says nothing
			...feature(
				'quoting',
				`${marked('weekly-deps', 'q')}\n\n\`\`\`json\n${sourceMarker('sentry', 'issue-1')}\n\`\`\``
			)
		],
		async ({ tracker, id }) => {
			const found = await tracker.featuresFrom('sentry');
			assert.deepEqual(
				found.map(({ id, key, open }) => ({ id, key, open })),
				[
					{ id: id('first'), key: 'issue-1', open: true },
					{ id: id('closed'), key: 'issue-2', open: false },
					{ id: id('keyless'), key: '', open: true }
				]
			);
			const times = found.map((f) => Date.parse(f.at));
			assert.ok(
				times.every((t, i) => !Number.isNaN(t) && t >= (times[i - 1] ?? t)),
				`each Feature's time is a date, none before the one above it: ${found.map((f) => f.at).join(', ')}`
			);
			assert.deepEqual(
				(await tracker.featuresFrom('weekly-deps')).map((f) => f.id),
				[id('other'), id('quoting')]
			);
		}
	),

	sourcesCase(
		'finds nothing for a Source that made no Feature, and does not take one Source for another that starts with its name',
		[...feature('long', marked('sentry-prod', 'issue-1')), ...feature('plain', 'No marker.')],
		async ({ tracker }) => {
			assert.deepEqual(await tracker.featuresFrom('sentry'), []);
			assert.deepEqual(await tracker.featuresFrom('never-made'), []);
		}
	),

	sourcesCase(
		'finds a Feature it has just made through createFeature, its marker as written',
		feature('old', marked('sentry', 'issue-1')),
		async ({ tracker, id }) => {
			// a Tracker that makes no Features has none of its own to find
			if (!canCreate(tracker)) return;
			const made = await tracker.createFeature({
				title: 'New event',
				body: marked('sentry', 'issue-3', 'The new event, with <b>markup</b> & `ticks`.')
			});
			await tracker.createTicket(made, { title: 'Ticket', body: 'Build it.' });
			assert.deepEqual(
				(await tracker.featuresFrom('sentry')).map(({ id, key, open }) => ({ id, key, open })),
				[
					{ id: id('old'), key: 'issue-1', open: true },
					{ id: made, key: 'issue-3', open: true }
				]
			);
		}
	)
];
