// `nightjar create` makes what a Feature file holds on the Tracker, and a build reads it back as
// written: each Tracker here is real over a fake system, or the in-memory fake.
import { describe, expect, it } from 'vitest';
import { AzureDevOpsApi } from './azure-devops/api.js';
import { FakeAzureDevOps } from './azure-devops/fake-azure-devops.js';
import { AzureBoardsTracker } from './azure-devops/tracker.js';
import { ticketLine } from './build.js';
import { makeFeature } from './create.js';
import { FakeTracker } from './fakes/tracker.js';
import { readFeatureFile } from './feature-file.js';
import { FakeGitHub } from './github/fake-github.js';
import { GitHubTracker } from './github/tracker.js';
import { nextTicket } from './plan.js';
import { DEFAULT_SIGNAL_NAMES, SIGNALS, type Signal } from './signals.js';
import type { FeatureWriter, Tracker } from './tracker.js';

const FILE = `# Share one HTML escape

Two renderers escape HTML their own way.

## Ticket 1: Move the escape into one module

**Model:** opus
**Effort:** high

Move it.

### Acceptance criteria

- [ ] one module exports escapeHtml

## Ticket 2: Use it in the comment renderer

**Blocked by:** 1

### Acceptance criteria

- [ ] comments escape through it

## Ticket 3: Use it in the page renderer

**Blocked by:** 1, 2

### Acceptance criteria

- [ ] pages escape through it
`;

interface Subject {
	readonly tracker: Tracker & FeatureWriter;
	// the Signals an item carries, read from the system itself
	readonly signalsOf: (id: number) => Promise<Signal[]>;
}

const fromNames = (names: readonly string[]) =>
	SIGNALS.filter((s) => names.some((n) => n.toLowerCase() === DEFAULT_SIGNAL_NAMES[s]));

const TRACKERS: [string, () => Subject][] = [
	[
		'the in-memory fake',
		() => {
			const tracker = new FakeTracker();
			return { tracker, signalsOf: (id) => Promise.resolve([...tracker.signalsOf(id)]) };
		}
	],
	[
		'GitHub Issues',
		() => {
			const github = new FakeGitHub('o/r', 'ann');
			return {
				tracker: new GitHubTracker('o/r', github.gh, DEFAULT_SIGNAL_NAMES),
				signalsOf: async (id) => {
					const got = await github.gh(['api', `repos/o/r/issues/${String(id)}`]);
					const issue = JSON.parse(got.out) as { labels: { name: string }[] };
					return fromNames(issue.labels.map((l) => l.name));
				}
			};
		}
	],
	[
		'Azure DevOps Boards',
		() => {
			const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
			const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
			const settings = { project: 'Fabrikam', featureType: 'Epic', ticketType: 'Issue' };
			return {
				tracker: new AzureBoardsTracker(api, settings, DEFAULT_SIGNAL_NAMES),
				signalsOf: (id) => Promise.resolve(fromNames(ado.tagsOf(id)))
			};
		}
	]
];

describe.each(TRACKERS)('makeFeature on %s', (_name, subject) => {
	it('makes the Feature with no Signal and its Tickets ready, which a build reads back in Build order', async () => {
		const { tracker, signalsOf } = subject();
		const plan = readFeatureFile(FILE);
		const made = await makeFeature(tracker, plan, () => undefined);

		expect(await tracker.feature(made.feature)).toEqual({
			id: made.feature,
			title: 'Share one HTML escape',
			body: 'Two renderers escape HTML their own way.'
		});
		expect(await signalsOf(made.feature)).toEqual([]);

		const tickets = await tracker.tickets(made.feature);
		expect(tickets.map((t) => t.id)).toEqual(made.tickets);
		expect(tickets.map((t) => t.title)).toEqual([
			'Move the escape into one module',
			'Use it in the comment renderer',
			'Use it in the page renderer'
		]);
		expect(tickets.map((t) => t.body)).toEqual(plan.tickets.map((t) => t.body));
		expect(tickets.map((t) => t.signals)).toEqual([['ready'], ['ready'], ['ready']]);
		for (const id of made.tickets) expect(await signalsOf(id)).toEqual(['ready']);

		const [a = 0, b = 0, c = 0] = made.tickets;
		expect(tickets.map((t) => t.blockedBy.map((x) => x.id).sort())).toEqual([
			[],
			[a],
			[a, b].sort()
		]);
		expect([
			ticketLine(tickets[0]?.body ?? '', 'Model'),
			ticketLine(tickets[0]?.body ?? '', 'Effort')
		]).toEqual(['opus', 'high']);
		// built in the order the file gives, each after what blocks it
		const built = new Set<number>();
		const order: number[] = [];
		for (let next = nextTicket(tickets, built); next; next = nextTicket(tickets, built)) {
			order.push(next.id);
			built.add(next.id);
		}
		expect(order).toEqual([a, b, c]);
	});
});

describe('makeFeature', () => {
	it('says what it made as it goes, by the Tracker’s own references', async () => {
		const lines: string[] = [];
		await makeFeature(new FakeTracker(), readFeatureFile(FILE), (line) => lines.push(line));
		expect(lines).toEqual([
			'made the Feature #1 Share one HTML escape',
			'made Ticket 1 as #2 Move the escape into one module, ready',
			'made Ticket 2 as #3 Use it in the comment renderer, blocked by #2, ready',
			'made Ticket 3 as #4 Use it in the page renderer, blocked by #2 and #3, ready'
		]);
	});

	it('says what it made before the fault when the Tracker fails part way', async () => {
		const tracker = new FakeTracker();
		const make = tracker.createTicket;
		let count = 0;
		tracker.createTicket = (feature, ticket) =>
			(count += 1) === 2 ? Promise.reject(new Error('the Tracker is down')) : make(feature, ticket);
		await expect(makeFeature(tracker, readFeatureFile(FILE), () => undefined)).rejects.toThrow(
			'the Tracker is down; made before it: #1, #2. Nothing was undone.'
		);
	});
});
