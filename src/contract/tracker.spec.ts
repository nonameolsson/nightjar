// The Tracker suite is no rubber stamp: a Tracker that breaks one rule fails the case for it.
import { describe, expect, it } from 'vitest';
import { fakeTrackerHarness } from '../fakes/harness.js';
import type { Tracker } from '../tracker.js';
import { trackerContract, type TrackerHarness } from './tracker.js';

function broken(over: (tracker: Tracker) => Partial<Tracker>): TrackerHarness {
	return async (world) => {
		const subject = await fakeTrackerHarness(world);
		const tracker = subject.tracker;
		return { ...subject, tracker: { ...tracker, ...over(tracker) } };
	};
}

function caseNamed(start: string) {
	const found = trackerContract.find((c) => c.name.startsWith(start));
	if (found === undefined) throw new Error(`no Tracker case starts with ${start}`);
	return found;
}

describe('the Tracker contract', () => {
	it('fails a Tracker that lists Features without the Go', async () => {
		const harness = broken((t) => ({
			assignedFeatures: async () => [...(await t.assignedFeatures('ann')), await t.feature(3)]
		}));
		await expect(caseNamed('lists the open Features').run(harness)).rejects.toThrow();
	});

	it('fails a Tracker that gives the Tickets in id order, not the child order', async () => {
		const harness = broken((t) => ({
			tickets: async (id) => (await t.tickets(id)).sort((a, b) => a.id - b.id)
		}));
		await expect(caseNamed("reads a Feature's Tickets").run(harness)).rejects.toThrow();
	});

	it('fails a Tracker that drops the blockers from another Feature', async () => {
		const harness = broken((t) => ({
			tickets: async (id) =>
				(await t.tickets(id)).map((ticket) => ({
					...ticket,
					blockedBy: ticket.blockedBy.filter((b) => b.open)
				}))
		}));
		await expect(caseNamed('gives each Ticket the items').run(harness)).rejects.toThrow();
	});

	it('fails a Tracker that trusts every comment', async () => {
		const harness = broken((t) => ({
			comments: async (id) => (await t.comments(id)).map((c) => ({ ...c, trusted: true }))
		}));
		await expect(caseNamed('reads the comments').run(harness)).rejects.toThrow();
	});

	it('fails a Tracker that shows two Signals under one mark', async () => {
		const harness = broken((t) => ({
			addSignal: (id, signal) => t.addSignal(id, signal === 'go' ? 'ready' : signal)
		}));
		await expect(caseNamed('adds each Signal').run(harness)).rejects.toThrow();
	});

	it('fails a Tracker that cannot take a Signal off', async () => {
		const harness = broken(() => ({ removeSignal: () => Promise.resolve() }));
		await expect(caseNamed('keeps a Signal added twice').run(harness)).rejects.toThrow();
		await expect(caseNamed('gives a Feature the Go').run(harness)).rejects.toThrow();
	});

	it('fails a Tracker that changes the body it comments', async () => {
		const harness = broken((t) => ({
			comment: (id, body) => t.comment(id, body.split('\n')[0] ?? '')
		}));
		await expect(caseNamed('comments as the signed-in').run(harness)).rejects.toThrow();
	});

	it('fails a Tracker whose references all read the same', async () => {
		const harness = broken(() => ({ reference: (id) => ({ id, text: 'the Feature' }) }));
		await expect(caseNamed('gives each Ticket a reference').run(harness)).rejects.toThrow();
	});
});
