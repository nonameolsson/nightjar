// The in-memory fakes as the contract suites' harnesses: each world becomes a fresh fake.
import type { TrackerHarness } from '../contract/tracker.js';
import { FakeTracker } from './tracker.js';

export const fakeTrackerHarness: TrackerHarness = (world) => {
	const tracker = new FakeTracker(world.person);
	const ids = new Map(world.items.map((item, i) => [item.key, i + 1]));
	const id = (key: string) => {
		const found = ids.get(key);
		if (found === undefined) throw new Error(`the world has no item ${key}`);
		return found;
	};
	for (const item of world.items) {
		tracker.add({
			id: id(item.key),
			title: item.title,
			body: item.body ?? '',
			open: item.open ?? true,
			assignees: item.assignees ?? [],
			signals: item.signals ?? [],
			children: (item.children ?? []).map(id),
			blockedBy: (item.blockedBy ?? []).map(id)
		});
		for (const c of item.comments ?? []) {
			tracker.say(id(item.key), {
				author: c.author,
				body: c.body,
				trusted: world.trusted.includes(c.author)
			});
		}
	}
	return Promise.resolve({ tracker, id });
};
