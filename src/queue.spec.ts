// --once, --watch and --dry-run over the in-memory Tracker, with the build loop scripted.
import { describe, expect, it } from 'vitest';
import type { FeatureOutcome } from './build.js';
import { FakeCodeHost } from './fakes/code-host.js';
import { FakeTracker } from './fakes/tracker.js';
import { FOOTER } from './footer.js';
import type { Waiting } from './plan.js';
import { buildNamed, cannotClaim, dryRun, queue, type QueueDeps } from './queue.js';
import type { Doing, Happened, Queued, WaitingOnYou } from './status.js';
import type { FeedbackCommit } from './worktree.js';

function world() {
	const tracker = new FakeTracker('ann');
	tracker.add({ id: '4', title: 'Later', assignees: ['ann'], signals: ['go'], children: ['5'] });
	tracker.add({ id: '2', title: 'Older', assignees: ['ann'], signals: ['go'], children: ['3'] });
	tracker.add({ id: '6', title: 'Not mine', assignees: ['bob'], signals: ['go'], children: ['7'] });
	tracker.add({ id: '8', title: 'No Go', assignees: ['ann'], children: ['9'] });
	for (const id of ['3', '5', '7', '9']) tracker.add({ id, title: `Ticket ${id}` });
	const built: string[] = [];
	const lines: string[] = [];
	const doing: Doing[] = [];
	const happened: Happened[] = [];
	const moved: string[] = [];
	const refreshes: { queue: Queued[]; waitingOnYou: WaitingOnYou }[] = [];
	// refreshes and builds in the order they happened
	const trail: string[] = [];
	const sleeps: number[] = [];
	const stop = new AbortController();
	let outcome = (id: string): Promise<FeatureOutcome> => {
		built.push(id);
		trail.push(`build ${id}`);
		// as the build loop does, the Go comes off the Feature it takes
		return tracker.removeSignal(id, 'go').then(() => ({ kind: 'nothing', waiting: [] }));
	};
	// each Feature built, with what started it
	const starts: string[] = [];
	const deps: QueueDeps = {
		tracker,
		person: 'ann',
		build: ({ id }, start) => {
			starts.push(`${id} ${start ?? 'go'}`);
			return outcome(id);
		},
		status: {
			codeMoved: (commit) => moved.push(commit),
			doing: (d) => doing.push(d),
			happened: (h) => happened.push(h),
			refreshed: (queue, waitingOnYou) => {
				refreshes.push({ queue, waitingOnYou });
				trail.push(`refresh ${queue.map((q) => q.id).join(',')}`);
			}
		},
		now: () => new Date(2026, 9, 30, 9),
		say: (line) => lines.push(line),
		sleep: (ms) => {
			sleeps.push(ms);
			if (sleeps.length >= 2) stop.abort();
			return Promise.resolve();
		},
		signal: stop.signal
	};
	const buildWaiting = (left: Waiting[]) => {
		outcome = (id) => {
			built.push(id);
			trail.push(`build ${id}`);
			return tracker.removeSignal(id, 'go').then(() => ({ kind: 'nothing', waiting: left }));
		};
	};
	const failWith = (fault: Error) => {
		outcome = async (id) => {
			built.push(id);
			await tracker.addSignal(id, 'working');
			await tracker.removeSignal(id, 'go');
			throw fault;
		};
	};
	return {
		tracker,
		deps,
		built,
		lines,
		doing,
		happened,
		sleeps,
		failWith,
		refreshes,
		moved,
		trail,
		buildWaiting,
		starts
	};
}

// Feature 8, assigned to ann without the Go, has an open draft pull request on its branch; the Feedback rounds on the branch are `commits`.
function withPull() {
	const w = world();
	const host = new FakeCodeHost();
	const commits = new Map<string, FeedbackCommit[]>();
	const branch = 'factory/8-no-go';
	w.deps = {
		...w.deps,
		pulls: {
			codeHost: host,
			feedbackCommits: (b) => Promise.resolve(commits.get(b) ?? [])
		}
	};
	void host.createDraft({ title: 'No Go', head: branch, base: 'main', body: '' });
	const pull = { id: 100, url: 'https://code.example/pull/100' };
	// a Feedback round on the branch at `minute` past midnight, when the fake Code host dates its feedback
	const round = (minute: number, o: { automatic?: boolean; ids?: string[] } = {}) => {
		const at = new Date(Date.UTC(2026, 9, 31, 0, minute, 30)).toISOString();
		const ids = o.ids ?? [`comment:${String(minute)}`];
		const made = { at, ids, automatic: o.automatic ?? true };
		commits.set(branch, [made, ...(commits.get(branch) ?? [])]);
	};
	const noGo = async () => {
		await w.tracker.removeSignal('2', 'go');
		await w.tracker.removeSignal('4', 'go');
	};
	return { ...w, host, pull, commits, branch, round, noGo };
}

const KEYED = 'factory/PROJ-3-keyed';

// Feature PROJ-3, whose id holds a dash, with an open pull request on its branch.
function keyedPull(w: ReturnType<typeof withPull>) {
	w.tracker.add({ id: 'PROJ-3', title: 'Keyed', assignees: ['ann'], children: ['9'] });
	void w.host.createDraft({ title: 'Keyed', head: KEYED, base: 'main', body: '' });
	return { id: 101, url: 'https://code.example/pull/101' };
}

describe('queue --once', () => {
	it('builds the oldest Feature assigned to the person with the Go, then exits', async () => {
		const w = world();
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.built).toEqual(['2']);
	});

	it('says so and exits when no Feature with the Go is assigned to the person', async () => {
		const w = world();
		await w.tracker.removeSignal('2', 'go');
		await w.tracker.removeSignal('4', 'go');
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.built).toEqual([]);
		expect(w.lines).toContain('no Feature with the Go is assigned to ann');
	});

	it('hands the Feature back when its build fails on a fault', async () => {
		const w = world();
		w.failWith(new Error('the network went away'));
		expect(await queue(w.deps, true)).toBe(1);
		expect(w.tracker.signalsOf('2')).toEqual(['needsInfo']);
		expect(w.tracker.said('2')[0]).toMatch(/^Nightjar stopped on a fault: the network went away/);
		expect(w.happened).toEqual([
			{ kind: 'failed', feature: '2', title: 'Older', why: 'the network went away' }
		]);
	});
});

describe('queue --watch', () => {
	it('builds each Feature in turn, then waits and looks again until stopped', async () => {
		const w = world();
		expect(await queue(w.deps, false)).toBe(130);
		expect(w.built).toEqual(['2', '4']);
		expect(w.sleeps).toEqual([120_000, 120_000]);
		expect(w.doing.at(-1)).toEqual({
			kind: 'idle',
			nextPollAt: new Date(2026, 9, 30, 9, 2).toISOString()
		});
	});
});

describe('queue --watch with newer Nightjar code', () => {
	it('says so once per version while idle, in the output and the status file', async () => {
		const w = world();
		w.deps = { ...w.deps, newer: () => Promise.resolve('0.3.0') };
		await queue(w.deps, false);
		// the sleep stops the second idle: one say for two checks
		expect(w.lines.filter((l) => l.includes('0.3.0'))).toHaveLength(1);
		expect(w.lines.find((l) => l.includes('0.3.0'))).toMatch(/newer Nightjar/);
		expect(w.happened.filter((h) => h.kind === 'stale')).toEqual([
			{ kind: 'stale', commit: '0.3.0' }
		]);
		expect(w.moved).toEqual(['0.3.0']);
	});

	it('says again for a still newer version', async () => {
		const w = world();
		const versions = ['0.3.0', '0.4.0'];
		w.deps = { ...w.deps, newer: () => Promise.resolve(versions.shift() ?? null) };
		await queue(w.deps, false);
		expect(w.moved).toEqual(['0.3.0', '0.4.0']);
	});

	it('does not check outside --watch', async () => {
		const w = world();
		let checked = 0;
		w.deps = { ...w.deps, newer: () => ((checked += 1), Promise.resolve('0.3.0')) };
		await queue(w.deps, true);
		expect(checked).toBe(0);
	});
});

describe('the Queue in the status file', () => {
	it('is the Features after the one taken, written before it builds', async () => {
		const w = world();
		await queue(w.deps, true);
		expect(w.refreshes[0]?.queue).toEqual([{ id: '4', title: 'Later' }]);
		// and again once it ended, for what its Tickets left
		expect(w.trail).toEqual(['refresh 4', 'build 2', 'refresh 4']);
	});

	it('is refreshed between Features and on each idle poll, never mid-build', async () => {
		const w = world();
		await queue(w.deps, false);
		expect(w.trail).toEqual([
			'refresh 4',
			'build 2',
			'refresh 4',
			'refresh ',
			'build 4',
			'refresh ',
			'refresh ',
			'refresh '
		]);
	});

	it('leaves it as it was when the Tracker cannot be asked', async () => {
		const w = world();
		w.tracker.assignedFeatures = () => Promise.reject(new Error('the network went away'));
		await queue(w.deps, false);
		expect(w.refreshes).toEqual([]);
	});

	it('puts in Waiting on you the Tickets the last Feature left that need info or a person, and says the Tracker cannot list Features', async () => {
		const w = world();
		// a Tracker module written before waitingOn
		Object.assign(w.tracker, { waitingOn: undefined });
		w.buildWaiting([
			{ id: '3', title: 'Ticket 3', why: 'needs info' },
			{ id: '5', title: 'Ticket 5', why: 'not reached' },
			{ id: '9', title: 'Ticket 9', why: 'needs a person' },
			{ id: '7', title: 'Ticket 7', why: 'blocked by', blocker: '3' }
		]);
		await queue(w.deps, false);
		expect(w.refreshes[0]?.waitingOnYou).toEqual({ items: [], trackerCannotList: true });
		expect(w.refreshes[1]?.waitingOnYou).toEqual({
			items: [
				{ kind: 'ticket', id: '3', title: 'Ticket 3', why: 'needs info' },
				{ kind: 'ticket', id: '9', title: 'Ticket 9', why: 'needs a person' }
			],
			trackerCannotList: true
		});
	});
});

describe("the last Feature's Tickets in Waiting on you", () => {
	const left: Waiting[] = [{ id: '3', title: 'Ticket 3', why: 'needs info' }];
	const ticket = { kind: 'ticket', id: '3', title: 'Ticket 3', why: 'needs info' };

	// the first Feature leaves a Ticket for a person, the second ends as `second` says
	async function afterSecond(second: (id: string) => Promise<FeatureOutcome>) {
		const w = world();
		const build = ({ id }: { id: string }): Promise<FeatureOutcome> =>
			id === '2'
				? w.tracker.removeSignal(id, 'go').then(() => ({ kind: 'nothing', waiting: left }))
				: w.tracker.removeSignal(id, 'go').then(() => second(id));
		await queue({ ...w.deps, build }, false);
		return w.refreshes.map((r) => r.waitingOnYou.items.filter((i) => i.kind === 'ticket'));
	}

	it('shows them as soon as the Feature ends, and drops them at the next poll, when it is no longer current', async () => {
		const shown = await afterSecond(() => Promise.resolve({ kind: 'nothing', waiting: [] }));
		// before Feature 2, after it, before Feature 4, after it, then two idle polls
		expect(shown).toEqual([[], [ticket], [], [], [], []]);
	});

	it("drops them when the next Feature fails, since they are no longer the last one's", async () => {
		const shown = await afterSecond(() => Promise.reject(new Error('boom')));
		expect(shown[3]).toEqual([]);
	});

	it('drops them when the next Feature pauses', async () => {
		const shown = await afterSecond(() =>
			Promise.resolve({ kind: 'paused', why: 'daily limit reached' })
		);
		expect(shown[3]).toEqual([]);
	});
});

describe('Waiting on you from a Tracker that has waitingOn', () => {
	function withWaiting() {
		const w = world();
		w.tracker.add({
			id: '10',
			title: 'Asks',
			assignees: ['ann'],
			signals: ['needsInfo'],
			children: ['11']
		});
		w.tracker.add({
			id: '12',
			title: 'Stuck',
			assignees: ['ann'],
			signals: ['human'],
			children: ['13']
		});
		w.tracker.add({
			id: '14',
			title: 'Theirs',
			assignees: ['bob'],
			signals: ['needsInfo'],
			children: ['15']
		});
		for (const id of ['11', '13', '15']) w.tracker.add({ id, title: `Ticket ${id}` });
		return w;
	}

	it('lists the Features assigned to the person that carry needs info or needs a person, and no longer says the Tracker cannot list', async () => {
		const w = withWaiting();
		await queue(w.deps, true);
		expect(w.refreshes[0]?.waitingOnYou).toEqual({
			items: [
				{ kind: 'feature', id: '10', title: 'Asks', why: 'needs info' },
				{ kind: 'feature', id: '12', title: 'Stuck', why: 'needs a person' }
			],
			trackerCannotList: false
		});
	});

	it("puts the last Feature's waiting Tickets after the Features", async () => {
		const w = withWaiting();
		w.buildWaiting([{ id: '3', title: 'Ticket 3', why: 'needs info' }]);
		await queue(w.deps, false);
		expect(w.refreshes[1]?.waitingOnYou).toEqual({
			items: [
				{ kind: 'feature', id: '10', title: 'Asks', why: 'needs info' },
				{ kind: 'feature', id: '12', title: 'Stuck', why: 'needs a person' },
				{ kind: 'ticket', id: '3', title: 'Ticket 3', why: 'needs info' }
			],
			trackerCannotList: false
		});
	});

	it("reads each Feature's Signal from waitingOn, with no Tracker call per Feature", async () => {
		const w = withWaiting();
		const asked: string[] = [];
		const standing = w.tracker.standing;
		w.tracker.standing = (id) => {
			asked.push(id);
			return standing(id);
		};
		w.deps = { ...w.deps, build: () => Promise.resolve({ kind: 'nothing', waiting: [] }) };
		await queue(w.deps, true);
		expect(asked).toEqual([]);
	});

	it('says what went wrong when it fails, and still builds', async () => {
		const w = withWaiting();
		w.tracker.waitingOn = () => Promise.reject(new Error('the network went away'));
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.lines).toContain('could not read what waits on ann: the network went away');
		expect(w.built).toEqual(['2']);
	});
});

describe('a trusted request for changes under --once and --watch', () => {
	const asks = (w: ReturnType<typeof withPull>, trusted = true) => {
		const author = trusted ? 'bob' : 'eve';
		w.host.requestChanges(w.pull, { author, trusted, body: 'Rename it.' });
	};

	it('starts a Feedback round on an open Nightjar pull request with no Go given, after the Features with the Go', async () => {
		const w = withPull();
		asks(w);
		const build = w.deps.build;
		// the round lands as a commit on the branch, after the request
		w.deps = {
			...w.deps,
			build: async (f, start) => {
				const got = await build(f, start);
				if (f.id === '8') w.round(5);
				return got;
			}
		};
		expect(await queue(w.deps, false)).toBe(130);
		expect(w.starts).toEqual(['2 go', '4 go', '8 changesRequested']);
	});

	it('takes it under --once when no Feature has the Go', async () => {
		const w = withPull();
		await w.noGo();
		asks(w);
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.starts).toEqual(['8 changesRequested']);
	});

	it('builds a Feature with the Go first under --once', async () => {
		const w = withPull();
		asks(w);
		await queue(w.deps, true);
		expect(w.starts).toEqual(['2 go']);
	});

	it('starts nothing on an untrusted request for changes', async () => {
		const w = withPull();
		await w.noGo();
		asks(w, false);
		w.host.give(w.pull, { kind: 'comment', author: 'bob', body: 'A nit.', trusted: true });
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.starts).toEqual([]);
		expect(w.lines).toContain('no Feature with the Go is assigned to ann');
	});

	it('starts nothing on a request for changes the last Feedback round came after', async () => {
		const w = withPull();
		await w.noGo();
		asks(w);
		w.round(4);
		await queue(w.deps, true);
		expect(w.starts).toEqual([]);
	});

	it('starts nothing when the request leaves no trusted feedback unanswered', async () => {
		const w = withPull();
		await w.noGo();
		w.host.requestChanges(w.pull, { author: 'bob', trusted: true });
		await queue(w.deps, true);
		expect(w.starts).toEqual([]);

		const id = w.host.give(w.pull, { kind: 'comment', author: 'bob', body: 'Hm.', trusted: true });
		// answered by a round before this pull request, which counts as no round of it
		w.round(-5, { ids: [id] });
		await queue(w.deps, true);
		expect(w.starts).toEqual([]);
	});

	it("leaves a Feature that is not the person's, or carries working, needs info or needs a person", async () => {
		for (const held of ['working', 'needsInfo', 'human'] as const) {
			const w = withPull();
			await w.noGo();
			asks(w);
			await w.tracker.addSignal('8', held);
			await queue(w.deps, true);
			expect(w.starts).toEqual([]);
		}
		const w = withPull();
		await w.noGo();
		await w.tracker.removeSignal('6', 'go');
		asks(w);
		await queue({ ...w.deps, person: 'bob' }, true);
		expect(w.starts).toEqual([]);
	});

	it('leaves a branch whose Feature has another title now, and a branch no Feature has', async () => {
		const w = withPull();
		await w.noGo();
		w.tracker.add({ id: '8', title: 'Renamed', assignees: ['ann'], children: ['9'] });
		void w.host.createDraft({ title: 'Gone', head: 'factory/77-gone', base: 'main', body: '' });
		asks(w);
		w.host.requestChanges({ id: 101, url: '' }, { author: 'bob', trusted: true, body: 'Hm.' });
		await queue(w.deps, true);
		expect(w.starts).toEqual([]);
	});

	it('finds the Feature of a branch whose id holds a dash', async () => {
		const w = withPull();
		await w.noGo();
		const keyed = keyedPull(w);
		w.host.requestChanges(keyed, { author: 'bob', trusted: true, body: 'Hm.' });
		await queue(w.deps, true);
		expect(w.starts).toEqual(['PROJ-3 changesRequested']);
	});

	it('starts no sixth automatic round: the Feature gets needs a person and a comment saying why, once', async () => {
		const w = withPull();
		await w.noGo();
		for (const minute of [0, 0, 0, 0, 0]) w.round(minute);
		asks(w);
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.starts).toEqual([]);
		expect(w.tracker.signalsOf('8')).toEqual(['human']);
		expect(w.tracker.said('8')).toEqual([
			`A trusted reviewer asked for changes on ${w.pull.url} again, after the 5 automatic Feedback rounds Nightjar runs on one pull request without the Go, so this Feature needs a person. Give it the Go to have Nightjar answer the feedback in one more round.${FOOTER}`
		]);
		expect(w.happened).toContainEqual({
			kind: 'needs-info',
			feature: '8',
			ticket: null,
			why: 'its pull request had 5 automatic Feedback rounds'
		});
		await queue(w.deps, true);
		expect(w.tracker.said('8')).toHaveLength(1);
	});

	it('counts only the automatic rounds of this pull request against the limit', async () => {
		const w = withPull();
		await w.noGo();
		for (const minute of [0, 0, 0, 0]) w.round(minute);
		// one the Go started, and one of a pull request the branch had before
		w.round(0, { automatic: false });
		w.round(-5);
		asks(w);
		await queue(w.deps, true);
		expect(w.starts).toEqual(['8 changesRequested']);
	});

	it('starts nothing over a Code host without openPulls, and says a Code host it cannot read', async () => {
		const w = withPull();
		await w.noGo();
		asks(w);
		const { openPulls: _gone, ...older } = w.host;
		const pulls = { codeHost: older, feedbackCommits: () => Promise.resolve([]) };
		await queue({ ...w.deps, pulls }, true);
		expect(w.starts).toEqual([]);

		w.host.openPulls = () => Promise.reject(new Error('the network went away'));
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.lines).toContain('could not read the open pull requests: the network went away');
	});
});

describe('cannotClaim', () => {
	it('lets the person take a Feature assigned to them with the Go', async () => {
		const w = world();
		expect(await cannotClaim(w.deps, '2')).toBeNull();
	});

	it('reads the person in any case, as a Tracker does', async () => {
		const w = world();
		expect(await cannotClaim({ ...w.deps, person: 'ANN' }, '2')).toBeNull();
	});

	it('refuses a Feature assigned to someone else', async () => {
		const w = world();
		expect(await cannotClaim(w.deps, '6')).toBe(
			'#6 is not assigned to ann, so Nightjar leaves it alone. Assign it to ann first.'
		);
	});

	it('refuses a Feature without the Go', async () => {
		const w = world();
		expect(await cannotClaim(w.deps, '8')).toBe(
			'#8 does not carry the Go, so Nightjar leaves it alone. Give it the Go first.'
		);
	});

	it('refuses a Feature already carrying working, whether or not the Go is back', async () => {
		const w = world();
		await w.tracker.addSignal('2', 'working');
		const refusal =
			'#2 already carries the working Signal: another run is building it, or one stopped without clearing it. If none is running, take the Signal off and run again.';
		expect(await cannotClaim(w.deps, '2')).toBe(refusal);
		await w.tracker.removeSignal('2', 'go');
		expect(await cannotClaim(w.deps, '2')).toBe(refusal);
	});
});

describe('dryRun', () => {
	it('lists what it would build, and builds nothing', async () => {
		const w = world();
		await dryRun(w.deps);
		expect(w.lines).toEqual(['would build #2 Older', 'would build #4 Later']);
		expect(w.built).toEqual([]);
	});

	it('names the Features it would answer feedback on, and the ones it would hand to a person, changing nothing', async () => {
		const w = withPull();
		w.host.requestChanges(w.pull, { author: 'bob', trusted: true, body: 'Rename it.' });
		const keyed = keyedPull(w);
		w.host.requestChanges(keyed, { author: 'bob', trusted: true, body: 'Hm.' });
		// after its pull request opened, at the minute of the first request, and before its own
		const at = new Date(Date.UTC(2026, 9, 31, 0, 1, 30)).toISOString();
		const rounds = [1, 2, 3, 4, 5].map((n) => ({ at, ids: [`x:${String(n)}`], automatic: true }));
		w.commits.set(KEYED, rounds);
		await dryRun(w.deps);
		expect(w.lines).toEqual([
			'would build #2 Older',
			'would build #4 Later',
			`would answer feedback on #8 No Go, asked for changes on ${w.pull.url}`,
			`would hand #PROJ-3 Keyed to a person: ${keyed.url} had 5 automatic Feedback rounds`
		]);
		expect(w.tracker.signalsOf('PROJ-3')).toEqual([]);
		expect(w.tracker.said('PROJ-3')).toEqual([]);
	});
});

describe('nightjar <id>', () => {
	it('reads the Queue and Waiting on you before it builds, the named Feature not in the Queue', async () => {
		const w = world();
		expect(await buildNamed(w.deps, '4')).toEqual({ kind: 'nothing', waiting: [] });
		expect(w.trail).toEqual(['refresh 2', 'build 4', 'refresh 2']);
		expect(w.refreshes[0]?.waitingOnYou).toEqual({ items: [], trackerCannotList: false });
	});

	it('names the Feature in the failed event', async () => {
		const w = world();
		w.failWith(new Error('boom'));
		expect(await buildNamed(w.deps, '4')).toBeNull();
		expect(w.happened).toContainEqual({
			kind: 'failed',
			feature: '4',
			title: 'Later',
			why: 'boom'
		});
	});
});
