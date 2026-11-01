// --once, --watch and --dry-run over the in-memory Tracker, with the build loop scripted.
import { describe, expect, it } from 'vitest';
import type { FeatureOutcome } from './build.js';
import { FakeTracker } from './fakes/tracker.js';
import { cannotClaim, dryRun, queue, type QueueDeps } from './queue.js';
import type { Doing, Happened } from './status.js';

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
	const sleeps: number[] = [];
	const stop = new AbortController();
	let outcome = (id: string): Promise<FeatureOutcome> => {
		built.push(id);
		// as the build loop does, the Go comes off the Feature it takes
		return tracker.removeSignal(id, 'go').then(() => ({ kind: 'nothing', waiting: [] }));
	};
	const deps: QueueDeps = {
		tracker,
		person: 'ann',
		build: (id) => outcome(id),
		status: { doing: (d) => doing.push(d), happened: (h) => happened.push(h) },
		now: () => new Date(2026, 9, 30, 9),
		say: (line) => lines.push(line),
		sleep: (ms) => {
			sleeps.push(ms);
			if (sleeps.length >= 2) stop.abort();
			return Promise.resolve();
		},
		signal: stop.signal
	};
	const failWith = (fault: Error) => {
		outcome = async (id) => {
			built.push(id);
			await tracker.addSignal(id, 'working');
			await tracker.removeSignal(id, 'go');
			throw fault;
		};
	};
	return { tracker, deps, built, lines, doing, happened, sleeps, failWith };
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
		expect(w.happened).toEqual([{ kind: 'failed', feature: '2', why: 'the network went away' }]);
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
