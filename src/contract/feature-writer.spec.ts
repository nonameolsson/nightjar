// The creation suite is no rubber stamp: a Tracker that makes things wrong fails the case for it.
import { describe, expect, it } from 'vitest';
import { fakeTrackerHarness } from '../fakes/harness.js';
import type { FakeTracker } from '../fakes/tracker.js';
import type { Tracker } from '../tracker.js';
import { featureWriterContract } from './feature-writer.js';
import type { TrackerHarness } from './tracker.js';

function broken(over: (tracker: FakeTracker) => Partial<FakeTracker>): TrackerHarness {
	return async (world) => {
		const subject = await fakeTrackerHarness(world);
		const tracker = subject.tracker as FakeTracker;
		Object.assign(tracker, over(tracker));
		return subject;
	};
}

function caseNamed(start: string) {
	const found = featureWriterContract.find((c) => c.name.startsWith(start));
	if (found === undefined) throw new Error(`no creation case starts with ${start}`);
	return found;
}

describe('the creation contract', () => {
	it('fails a Tracker that cannot create', async () => {
		const harness: TrackerHarness = async (world) => {
			const { tracker, ...rest } = await fakeTrackerHarness(world);
			const { createFeature: _gone, ...without } = tracker as FakeTracker;
			return { ...rest, tracker: without as unknown as Tracker };
		};
		await expect(caseNamed('makes a Feature').run(harness)).rejects.toThrow(/createFeature/);
	});

	it('fails a Tracker that puts each new Ticket first among the children', async () => {
		const harness = broken((t) => ({
			createTicket: async (featureId, ticket) => {
				const id = await t.createFeature(ticket);
				const feature = t.items.get(featureId);
				if (feature) t.items.set(featureId, { ...feature, children: [id, ...feature.children] });
				return id;
			}
		}));
		await expect(caseNamed('makes a Feature').run(harness)).rejects.toThrow();
	});

	it('fails a Tracker that loses the lines of a body', async () => {
		const harness = broken((t) => ({
			createTicket: (featureId, ticket) =>
				t.createTicket(featureId, { ...ticket, body: ticket.body.replace(/\n+/g, ' ') })
		}));
		await expect(caseNamed("keeps a Ticket's body").run(harness)).rejects.toThrow();
	});

	it('fails a Tracker that links blockers the wrong way round', async () => {
		const harness = broken((t) => ({ block: (id, blocker) => t.block(blocker, id) }));
		await expect(caseNamed('links a Ticket').run(harness)).rejects.toThrow();
	});
});
