// The in-memory fakes as the contract suites' harnesses: each world becomes a fresh fake.
import type { CodeHostHarness, CodeHostSubject } from '../contract/code-host.js';
import type { TrackerHarness } from '../contract/tracker.js';
import { FakeCodeHost } from './code-host.js';
import { FakeTracker } from './tracker.js';

export const fakeCodeHostHarness: CodeHostHarness = () =>
	Promise.resolve(fakeCodeHostSubject(new FakeCodeHost()));

// The fake keeps no commits, so each commit gets a folder of its own that names it.
export function fakeCodeHostSubject(codeHost: FakeCodeHost): CodeHostSubject {
	const commits = new Map<string, string>();
	return {
		codeHost,
		base: 'main',
		commit: () => {
			const n = String(commits.size + 1);
			const made = { folder: `/work/${n}`, commit: `c${n}` };
			commits.set(made.folder, made.commit);
			return Promise.resolve(made);
		},
		branch: (name) => {
			const last = codeHost.pushes.findLast((p) => p.branch === name);
			return Promise.resolve(last ? (commits.get(last.folder) ?? null) : null);
		},
		pull: (pull) => {
			const found = codeHost.pulls.find((p) => p.id === pull.id);
			if (found === undefined) throw new Error(`the fake Code host has no pull ${String(pull.id)}`);
			return Promise.resolve({
				title: found.title,
				head: found.head,
				base: found.base,
				body: found.body,
				draft: found.draft,
				references: found.references.map((r) => r.text),
				comments: found.comments
			});
		}
	};
}

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
