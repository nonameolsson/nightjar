// --once, --watch and --dry-run over the in-memory Tracker, with the build loop scripted.
import { describe, expect, it } from 'vitest';
import {
	featureMarker,
	markHandedOver,
	type FeatureOutcome,
	type PullFixOutcome,
	type RedDraft
} from './build.js';
import type { PullChecks } from './code-host.js';
import { FakeCodeHost } from './fakes/code-host.js';
import { FakeTracker, type NewItem } from './fakes/tracker.js';
import type { Waiting } from './plan.js';
import { buildNamed, cannotClaim, dryRun, pullChecksPass, queue, type QueueDeps } from './queue.js';
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
			{
				kind: 'failed',
				feature: '2',
				title: 'Older',
				why: 'the network went away',
				startedAt: new Date(2026, 9, 30, 9).toISOString()
			}
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

const FAILURE = {
	check: 'CI / test',
	job: 'test',
	step: 'Run npm test',
	logTail: 'Error: expected 1 to be 2'
};

// The world, with draft pull requests on a fake Code host and the Pull-check fix round scripted.
function withDrafts(w: ReturnType<typeof world>) {
	const host = new FakeCodeHost();
	const fixed: string[] = [];
	let outcome: (red: RedDraft) => Promise<PullFixOutcome> = async (red) => {
		// as a green round does, a new commit is pushed and its Pull checks start
		await host.push(`/work/${red.feature}`, red.draft.branch);
		return { kind: 'fixed', pull: red.draft.pull, round: 1 };
	};
	// a draft on Nightjar's branch for `feature`, its body naming it unless null
	const open = async (
		feature: string | null,
		checks: PullChecks = { pending: false, failed: [FAILURE] }
	) => {
		const branch = `factory/${feature ?? 'x'}-done`;
		await host.push(`/work/${branch}`, branch);
		const marker = feature === null ? '' : `\n\n${featureMarker(feature)}`;
		const body = `Nightjar built all of it.${marker}`;
		const pull = await host.createDraft({ title: 'Done', head: branch, base: 'main', body });
		host.setChecks(pull, checks);
		return pull;
	};
	// a Feature assigned to ann, built and holding no Signal
	const done = (id: string, over: Partial<NewItem> = {}) => {
		w.tracker.add({ id, title: `Done ${id}`, assignees: ['ann'], ...over });
	};
	w.deps = {
		...w.deps,
		pullChecks: {
			drafts: host.nightjarDrafts,
			fix: (red) => {
				fixed.push(red.feature);
				w.trail.push(`fix ${red.feature}`);
				return outcome(red);
			}
		}
	};
	return {
		host,
		open,
		done,
		fixed,
		fixWith: (o: (red: RedDraft) => Promise<PullFixOutcome>) => {
			outcome = o;
		}
	};
}

const work = (trail: readonly string[]) => trail.filter((t) => !t.startsWith('refresh'));

describe('queue --watch with the Pull-check pass', () => {
	it("fixes a red draft before it takes the next Feature, handing it the draft and the body's Feature", async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		const pull = await d.open('20');
		const handed: RedDraft[] = [];
		const fix = w.deps.pullChecks?.fix;
		w.deps = {
			...w.deps,
			pullChecks: {
				drafts: d.host.nightjarDrafts,
				fix: (red) => {
					handed.push(red);
					return fix ? fix(red) : Promise.reject(new Error('no fix'));
				}
			}
		};
		expect(await queue(w.deps, false)).toBe(130);
		expect(work(w.trail)).toEqual(['fix 20', 'build 2', 'build 4']);
		expect(handed).toMatchObject([
			{
				feature: '20',
				draft: {
					pull,
					branch: 'factory/20-done',
					checks: { pending: false, failed: [FAILURE] },
					personEngaged: false
				}
			}
		]);
	});

	it('takes the oldest red draft first, and the next before any Feature', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		d.done('22');
		await d.open('20');
		await d.open('22');
		await queue(w.deps, false);
		expect(work(w.trail)).toEqual(['fix 20', 'fix 22', 'build 2', 'build 4']);
	});

	it("leaves alone a draft that is pending, green, engaged, unmarked, on another person's Feature or on one holding a Signal", async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20', { pending: true, failed: [FAILURE] });
		d.done('22');
		await d.open('22', { pending: false, failed: [] });
		d.done('24');
		d.host.engage(await d.open('24'));
		await d.open(null);
		d.done('26', { assignees: ['bob'] });
		await d.open('26');
		d.done('28', { signals: ['needsInfo'] });
		await d.open('28');
		d.done('30', { signals: ['human'] });
		await d.open('30');
		await queue(w.deps, false);
		expect(d.fixed).toEqual([]);
		expect(w.built).toEqual(['2', '4']);
	});

	it('leaves alone a draft the pass handed to a person, after the Signal comes off too', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		const pull = await d.open('20');
		const body = d.host.pulls.find((p) => p.id === pull.id)?.body ?? '';
		await d.host.editBody(pull, markHandedOver(body));
		await queue(w.deps, false);
		expect(d.fixed).toEqual([]);
		expect(w.built).toEqual(['2', '4']);
	});

	it('takes a draft once at its head commit, so a round that pushed nothing does not hold up the Queue', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		const pull = await d.open('20');
		d.fixWith(() => Promise.resolve({ kind: 'gaveUp', pull, round: 1, why: 'still red' }));
		await queue(w.deps, false);
		expect(work(w.trail)).toEqual(['fix 20', 'build 2', 'build 4']);
	});

	it('goes on to the Queue when a round stops on a fault, saying so', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20');
		d.fixWith(() => Promise.reject(new Error('the network went away')));
		await queue(w.deps, false);
		expect(w.built).toEqual(['2', '4']);
		expect(w.lines.some((l) => l.includes('stopped on a fault: the network went away'))).toBe(true);
	});

	it('goes on to the Queue when the Code host cannot list the drafts, saying so', async () => {
		const w = world();
		w.deps = {
			...w.deps,
			pullChecks: {
				drafts: () => Promise.reject(new Error('the Code host is down')),
				fix: () => Promise.reject(new Error('never'))
			}
		};
		await queue(w.deps, false);
		expect(w.built).toEqual(['2', '4']);
		expect(w.lines.some((l) => l.includes('the Code host is down'))).toBe(true);
	});

	it('looks again on each idle tick, so a draft that turns red while nothing is queued is fixed', async () => {
		const w = world();
		await w.tracker.removeSignal('2', 'go');
		await w.tracker.removeSignal('4', 'go');
		const d = withDrafts(w);
		d.done('20');
		const pull = await d.open('20', { pending: true, failed: [] });
		const { sleep } = w.deps;
		w.deps = {
			...w.deps,
			sleep: (ms, signal) => {
				d.host.setChecks(pull, { pending: false, failed: [FAILURE] });
				return sleep(ms, signal);
			}
		};
		await queue(w.deps, false);
		expect(d.fixed).toEqual(['20']);
	});

	it('pauses as a build does when the round pauses, and takes the draft again after', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20');
		d.fixWith(() => Promise.resolve({ kind: 'paused', why: 'the daily limit was reached' }));
		await queue(w.deps, false);
		expect(w.sleeps).toEqual([30 * 60_000, 30 * 60_000]);
		expect(d.fixed).toEqual(['20', '20']);
		expect(w.doing[0]).toMatchObject({ kind: 'paused', why: 'the daily limit was reached' });
	});

	it('takes no draft in --once', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20');
		await queue(w.deps, true);
		expect(d.fixed).toEqual([]);
		expect(w.built).toEqual(['2']);
	});
});

describe('pullChecksPass', () => {
	const fix = () => Promise.resolve<PullFixOutcome>({ kind: 'stopped' });

	it('is there when factory.json turns it on and the Code host lists its drafts', () => {
		expect(pullChecksPass({ enabled: true }, new FakeCodeHost(), fix)).not.toBeNull();
	});

	it('is off when factory.json leaves it out or off, so --watch is as before', () => {
		expect(pullChecksPass(undefined, new FakeCodeHost(), fix)).toBeNull();
		expect(pullChecksPass({}, new FakeCodeHost(), fix)).toBeNull();
		expect(pullChecksPass({ enabled: false }, new FakeCodeHost(), fix)).toBeNull();
	});

	it('is off over a Code host without nightjarDrafts', () => {
		const { nightjarDrafts: _gone, ...without } = new FakeCodeHost();
		expect(pullChecksPass({ enabled: true }, without, fix)).toBeNull();
	});
});

describe('the Queue in the status file', () => {
	it('is the Features after the one taken, written before it builds', async () => {
		const w = world();
		await queue(w.deps, true);
		expect(w.refreshes[0]?.queue).toEqual([
			{ id: '4', title: 'Later', ticketCounts: { total: 1, closed: 0 } }
		]);
		// and again once it ended, for what its Tickets left
		expect(w.trail).toEqual(['refresh 4', 'build 2', 'refresh 4']);
	});

	it('carries the Ticket counts of the Queue and of Waiting on you', async () => {
		const w = world();
		w.tracker.add({
			id: '10',
			title: 'Asks',
			assignees: ['ann'],
			signals: ['needsInfo'],
			children: ['11', '12']
		});
		w.tracker.add({ id: '11', title: 'Ticket 11', open: false });
		w.tracker.add({ id: '12', title: 'Ticket 12' });
		await queue(w.deps, true);
		expect(w.refreshes[0]?.waitingOnYou.items).toEqual([
			{
				kind: 'feature',
				id: '10',
				title: 'Asks',
				why: 'needs info',
				ticketCounts: { total: 2, closed: 1 }
			}
		]);
	});

	it('marks a Feature whose count fails and still refreshes', async () => {
		const w = world();
		w.tracker.ticketCounts = () => Promise.resolve(new Map([['4', null]]));
		await queue(w.deps, true);
		expect(w.refreshes[0]?.queue).toEqual([{ id: '4', title: 'Later', ticketCounts: null }]);
	});

	it('marks every Feature unread and still refreshes when counting throws', async () => {
		const w = world();
		w.tracker.ticketCounts = () => Promise.reject(new Error('the network went away'));
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.refreshes[0]?.queue).toEqual([{ id: '4', title: 'Later', ticketCounts: null }]);
		expect(w.lines.some((l) => l.includes('could not count'))).toBe(true);
	});

	it('writes no count for a Tracker without ticketCounts', async () => {
		const w = world();
		Object.assign(w.tracker, { ticketCounts: undefined });
		await queue(w.deps, true);
		expect(w.refreshes[0]?.queue).toEqual([{ id: '4', title: 'Later' }]);
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
				{ kind: 'ticket', id: '3', title: 'Ticket 3', why: 'needs info', feature: '2' },
				{ kind: 'ticket', id: '9', title: 'Ticket 9', why: 'needs a person', feature: '2' }
			],
			trackerCannotList: true
		});
	});
});

describe("the last Feature's Tickets in Waiting on you", () => {
	const left: Waiting[] = [{ id: '3', title: 'Ticket 3', why: 'needs info' }];
	const ticket = { kind: 'ticket', id: '3', title: 'Ticket 3', why: 'needs info', feature: '2' };

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

	const asks = { kind: 'feature', id: '10', title: 'Asks', why: 'needs info' } as const;
	const stuck = { kind: 'feature', id: '12', title: 'Stuck', why: 'needs a person' } as const;

	it('lists the Features assigned to the person that carry needs info or needs a person, and no longer says the Tracker cannot list', async () => {
		const w = withWaiting();
		await queue(w.deps, true);
		expect(w.refreshes[0]?.waitingOnYou).toEqual({
			items: [
				{ ...asks, ticketCounts: { total: 1, closed: 0 } },
				{ ...stuck, ticketCounts: { total: 1, closed: 0 } }
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
				{ ...asks, ticketCounts: { total: 1, closed: 0 } },
				{ ...stuck, ticketCounts: { total: 1, closed: 0 } },
				{ kind: 'ticket', id: '3', title: 'Ticket 3', why: 'needs info', feature: '2' }
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
			why: 'boom',
			startedAt: new Date(2026, 9, 30, 9).toISOString()
		});
	});
});
