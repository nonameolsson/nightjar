// --once, --watch and --dry-run over the in-memory Tracker, with the build loop scripted.
import { describe, expect, it } from 'vitest';
import type { FeatureOutcome } from './build.js';
import { FakeTracker } from './fakes/tracker.js';
import type { Waiting } from './plan.js';
import { buildNamed, cannotClaim, dryRun, queue, type QueueDeps } from './queue.js';
import type { Doing, Happened, Queued, WaitingOnYou } from './status.js';

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
	const deps: QueueDeps = {
		tracker,
		person: 'ann',
		build: ({ id }) => outcome(id),
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
		buildWaiting
	};
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
		let newer: string | null = '0.3.0';
		w.deps = { ...w.deps, newer: () => Promise.resolve(newer) };
		await queue(w.deps, false);
		// the sleep stops the second idle: one say for two checks
		expect(w.lines.filter((l) => l.includes('0.3.0'))).toHaveLength(1);
		expect(w.lines.find((l) => l.includes('0.3.0'))).toMatch(/newer Nightjar/);
		expect(w.happened.filter((h) => h.kind === 'stale')).toEqual([
			{ kind: 'stale', commit: '0.3.0' }
		]);
		expect(w.moved).toEqual(['0.3.0']);
		newer = null;
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
