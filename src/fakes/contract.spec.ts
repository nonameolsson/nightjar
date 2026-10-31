// The in-memory fakes against the Adapter contract suites, taken from the package's own entry.
import { describe, it } from 'vitest';
import { FakeTracker, trackerContract, type TrackerWorld } from '../index.js';

function fakeTracker(world: TrackerWorld) {
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
}

describe('FakeTracker meets the Tracker contract', () => {
	for (const c of trackerContract) it(c.name, () => c.run(fakeTracker));
});
