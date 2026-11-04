// The in-memory fakes as the contract suites' harnesses: each world becomes a fresh fake.
import type { Pull } from '../code-host.js';
import type { CodeHostHarness, CodeHostSubject, Given } from '../contract/code-host.js';
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
		},
		bench: {
			give: (pull, given) => Promise.resolve(giveTo(codeHost, pull, given)),
			thread: (pull, id) =>
				Promise.resolve(
					codeHost.threads.filter((t) => t.pull === pull.id && t.id === id).map((t) => t.body)
				)
		}
	};
}

// The fake shows an empty approval, or a check that did not fail, as nothing, so it keeps neither.
function giveTo(codeHost: FakeCodeHost, pull: Pull, given: Given): string {
	if (given.kind === 'check') {
		if (given.conclusion !== 'failure' && given.conclusion !== 'timed_out') return 'check:0';
		return codeHost.giveCheck(pull, {
			name: given.name,
			output: given.output,
			author: given.trusted ? 'github-actions' : 'unknown-app',
			trusted: given.trusted
		});
	}
	if (given.kind === 'review') {
		return codeHost.give(pull, {
			kind: 'review',
			author: given.author,
			body: given.body,
			trusted: given.trusted
		});
	}
	const where = given.on;
	const place =
		where === undefined
			? {}
			: where.line === null
				? { path: where.path, outdated: true as const }
				: { path: where.path, line: where.line };
	return codeHost.give(pull, {
		kind: 'comment',
		author: given.author,
		body: given.body,
		trusted: given.trusted,
		...place
	});
}

export const fakeTrackerHarness: TrackerHarness = (world) => keyedTrackerHarness('')(world);

// The fake Tracker keyed as `prefix` says, so `PROJ-` gives PROJ-1, PROJ-2 and on.
export const keyedTrackerHarness =
	(prefix: string): TrackerHarness =>
	(world) => {
		const tracker = new FakeTracker(world.person, () => new Date(), prefix);
		tracker.trust(...world.trusted);
		const ids = new Map(world.items.map((item, i) => [item.key, `${prefix}${String(i + 1)}`]));
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
