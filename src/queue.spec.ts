// --once, --watch and --dry-run over the in-memory Tracker, with the build loop scripted.
import { describe, expect, it } from 'vitest';
import {
	featureMarker,
	featureOfBody,
	markHandedOver,
	type ConflictFixOutcome,
	type ConflictingDraft,
	type FeatureOutcome,
	type PullFixOutcome,
	type RedDraft
} from './build.js';
import type { ConflictState, OpenPull, PullChecks } from './code-host.js';
import { FakeCodeHost } from './fakes/code-host.js';
import { FakeTracker, type NewItem } from './fakes/tracker.js';
import { BuildFault } from './fault.js';
import { faultStep, nextStepText } from './next-step.js';
import type { Waiting } from './plan.js';
import {
	buildNamed,
	cannotClaim,
	conflictsPass,
	dryRun,
	featureExit,
	fixNamed,
	PAUSE_MS,
	publishPass,
	pullChecksPass,
	pullFixExit,
	queue,
	slotSay,
	type PortEnv,
	type QueueDeps
} from './queue.js';
import { publishMark, type PublishMark } from './publish.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';
import type { Doing, Happened, Queued, WaitingOnYou } from './status.js';
import { branchFor } from './worktree.js';

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
			finished: () => undefined,
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
		stop,
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

	// a paused build puts the Go back before it pushes; a push that then fails must not leave it on
	it('takes the Go off a Feature it hands back, so the next pass does not build it again', async () => {
		const w = world();
		const pausedThenRejected: QueueDeps['build'] = async ({ id }) => {
			await w.tracker.addSignal(id, 'working');
			await w.tracker.removeSignal(id, 'go');
			await w.tracker.addSignal(id, 'go');
			throw new Error('git could not push factory/2-older: ! [rejected]');
		};
		expect(await queue({ ...w.deps, build: pausedThenRejected }, true)).toBe(1);
		expect(w.tracker.signalsOf('2')).toEqual(['needsInfo']);
	});

	it('hands the Feature back when its build fails on a fault', async () => {
		const w = world();
		w.failWith(new Error('the network went away'));
		expect(await queue(w.deps, true)).toBe(1);
		expect(w.tracker.signalsOf('2')).toEqual(['needsInfo']);
		expect(w.tracker.said('2')[0]).toMatch(
			/^\*\*Waiting on you\*\*: Nightjar stopped on a fault: the network went away\./
		);
		expect(w.tracker.note('2')).toContain(
			'**Waiting on you**: Nightjar stopped on a fault: the network went away.'
		);
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

	it('gives a Feature handed back on a fault its Next step, in the comment and the event', async () => {
		const w = world();
		w.failWith(new Error('the network went away'));
		await queue({ ...w.deps, signals: DEFAULT_SIGNAL_NAMES }, true);
		// the network is a passing fault, so there is nothing to fix before the Go
		const next = faultStep(DEFAULT_SIGNAL_NAMES, { passing: true, pullFix: false });
		expect(w.tracker.said('2')[0]).toContain(nextStepText(next));
		expect(w.tracker.note('2')).toContain(nextStepText(next));
		expect(w.happened[0]).toMatchObject({ kind: 'failed', next });
	});

	it('names where in the build the fault happened, from the BuildFault the build throws', async () => {
		const w = world();
		w.failWith(
			new BuildFault(new Error('the disk is full'), {
				place: { kind: 'review' },
				tickets: [],
				session: 'session-4',
				pull: null
			})
		);
		await queue({ ...w.deps, signals: DEFAULT_SIGNAL_NAMES }, true);
		const [comment = ''] = w.tracker.said('2');
		expect(comment).toContain(
			'**Waiting on you**: Nightjar stopped on a fault in the Review: the disk is full.'
		);
		expect(comment).toContain('fix what it names before giving the Go again');
		expect(comment).toContain('session session-4');
		expect(w.tracker.said('2')).toHaveLength(1);
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

	it('waits the poll interval the person set', async () => {
		const w = world();
		await queue({ ...w.deps, pollMs: 45_000 }, false);
		expect(w.sleeps).toEqual([45_000, 45_000]);
	});

	// a paused build that had commits to push ends as a pull request, with the pause beside it
	describe('when a build that opened a pull request paused', () => {
		const pausedPull = (w: ReturnType<typeof world>): QueueDeps => ({
			...w.deps,
			build: async ({ id }) => {
				w.built.push(id);
				// a run that never waits would build for ever
				if (w.built.length >= 5) w.stop.abort();
				await w.tracker.removeSignal(id, 'go');
				await w.tracker.addSignal(id, 'go');
				return {
					kind: 'pull',
					pull: { id: 1, url: 'https://example.test/pull/1' },
					built: [],
					waiting: [],
					pause: { why: 'the plan usage limit was reached' }
				};
			}
		});

		it('waits out the pause before it builds again', async () => {
			const w = world();
			await queue(pausedPull(w), false);
			expect(w.sleeps).toEqual([30 * 60_000, 30 * 60_000]);
			expect(w.doing[0]).toMatchObject({
				kind: 'paused',
				why: 'the plan usage limit was reached'
			});
			expect(w.built).toEqual(['2', '2']);
		});

		it("posts no comment on a Tracker that keeps a Status note, which the build's note says it on", async () => {
			const w = world();
			await queue(pausedPull(w), false);
			expect(w.tracker.said('2')).toEqual([]);
		});

		it('tells a Tracker without a Status note once why it paused, so a person can see it', async () => {
			const w = world();
			const { statusNote: _gone, ...older } = w.tracker;
			await queue({ ...pausedPull(w), tracker: older }, false);
			const said = w.tracker.said('2').filter((c) => c.startsWith('Nightjar paused'));
			expect(said).toHaveLength(1);
			expect(said[0]).toContain('the plan usage limit was reached');
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
		return { kind: 'fixed', pull: red.draft.pull, round: 1, summary: 'Fixed.', usd: 1 };
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
				fix: (red, say) => {
					handed.push(red);
					return fix ? fix(red, say) : Promise.reject(new Error('no fix'));
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
		d.fixWith(() => Promise.resolve({ kind: 'gaveUp', pull, round: 1, why: 'still red', usd: 1 }));
		await queue(w.deps, false);
		expect(work(w.trail)).toEqual(['fix 20', 'build 2', 'build 4']);
	});

	it('hands the Feature back with needs info when a round ends on a push that failed, and goes on to the Queue', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		const pull = await d.open('20');
		d.fixWith(() =>
			Promise.resolve({
				kind: 'faulted',
				pull,
				round: 1,
				fault: new Error('the connection was reset'),
				title: 'Done',
				usd: 1
			})
		);
		await queue(w.deps, false);
		expect(w.tracker.signalsOf('20')).toEqual(['needsInfo']);
		expect(w.tracker.said('20').at(-1)).toMatch(
			/^\*\*Waiting on you\*\*: Nightjar stopped on a fault: the connection was reset/
		);
		expect(w.built).toEqual(['2', '4']);
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

	it('hands the Feature of a round that stops on a fault to a person, naming the Pull-check fix', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		const pull = await d.open('20');
		d.fixWith(() => Promise.reject(new Error('the disk is full')));
		await queue({ ...w.deps, signals: DEFAULT_SIGNAL_NAMES }, false);
		expect(w.tracker.signalsOf('20')).toEqual(['needsInfo']);
		const [comment = ''] = w.tracker.said('20');
		expect(comment).toContain(
			'**Waiting on you**: Nightjar stopped on a fault in a Pull-check fix: the disk is full.'
		);
		expect(comment).toContain(`The pull request: ${pull.url}`);
		expect(comment).toContain('Nightjar tries a Pull-check fix again');
		expect(w.tracker.note('20')).toContain('in a Pull-check fix: the disk is full.');
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
});

// The world with drafts, and the Conflict fix pass over the same Code host, its fix scripted.
function withConflicts(w: ReturnType<typeof world>) {
	const d = withDrafts(w);
	const resolved: string[] = [];
	let outcome: (c: ConflictingDraft) => Promise<ConflictFixOutcome> = async (c) => {
		// as a Conflict fix that pushed does, a new commit is on the branch and the conflict is gone
		await d.host.push(`/work/${c.feature}`, c.draft.branch);
		d.host.setConflict(c.draft.pull, 'no');
		return {
			kind: 'fixed',
			pull: c.draft.pull,
			round: 1,
			summary: 'Kept both.',
			files: ['a.ts'],
			usd: 2
		};
	};
	w.deps = {
		...w.deps,
		conflicts: {
			drafts: d.host.nightjarDrafts,
			fix: (c) => {
				resolved.push(c.feature);
				w.trail.push(`resolve ${c.feature}`);
				return outcome(c);
			}
		}
	};
	// a draft whose Pull checks passed, that the Code host says is in `conflict` with its base
	const conflicting = async (feature: string | null, conflict: ConflictState = 'yes') => {
		const pull = await d.open(feature, { pending: false, failed: [] });
		d.host.setConflict(pull, conflict);
		return pull;
	};
	return {
		...d,
		conflicting,
		resolved,
		resolveWith: (o: (c: ConflictingDraft) => Promise<ConflictFixOutcome>) => {
			outcome = o;
		}
	};
}

describe('queue --watch with the Conflict fix pass', () => {
	it('resolves the oldest conflicting draft before any red draft, both before Publish and the next Feature', async () => {
		const w = world();
		const c = withConflicts(w);
		c.done('20');
		c.done('22');
		c.done('24');
		c.done('26');
		await c.open('20');
		await c.conflicting('22');
		await c.conflicting('24');
		const ready = await c.open('26', { pending: false, failed: [] });
		const body = c.host.pulls.find((p) => p.id === ready.id)?.body ?? '';
		await c.host.editBody(ready, `${body}\n${publishMark({ complete: true, approved: true })}`);
		const pass = publishPass(true, c.host);
		if (pass === null) throw new Error('the fake Code host cannot publish');
		w.deps = {
			...w.deps,
			publish: {
				...pass,
				publish: async (draft) => {
					w.trail.push(`publish ${featureOfBody(draft.body) ?? ''}`);
					await pass.publish(draft);
				}
			}
		};
		await queue(w.deps, false);
		expect(work(w.trail)).toEqual([
			'resolve 22',
			'resolve 24',
			'fix 20',
			'publish 26',
			'build 2',
			'build 4'
		]);
	});

	it('hands the fix the draft and the Feature its body names', async () => {
		const w = world();
		const c = withConflicts(w);
		c.done('20');
		const pull = await c.conflicting('20');
		const handed: ConflictingDraft[] = [];
		c.resolveWith((got) => {
			handed.push(got);
			return Promise.resolve({ kind: 'skipped', why: 'a spec' });
		});
		await queue(w.deps, false);
		expect(handed).toMatchObject([
			{ feature: '20', draft: { pull, branch: 'factory/20-done', conflicts: 'yes' } }
		]);
	});

	it("leaves alone a draft that does not conflict, or whose state is unknown, and one engaged, unmarked, on another person's Feature or on one holding a Signal", async () => {
		const w = world();
		const c = withConflicts(w);
		c.done('20');
		await c.conflicting('20', 'no');
		c.done('22');
		await c.conflicting('22', 'unknown');
		c.done('24');
		c.host.engage(await c.conflicting('24'));
		await c.conflicting(null);
		c.done('26', { assignees: ['bob'] });
		await c.conflicting('26');
		c.done('28', { signals: ['needsInfo'] });
		await c.conflicting('28');
		c.done('30', { signals: ['human'] });
		await c.conflicting('30');
		await queue(w.deps, false);
		expect(c.resolved).toEqual([]);
		expect(w.built).toEqual(['2', '4']);
	});

	it('leaves alone a draft the Code host lists with no conflict state', async () => {
		const w = world();
		const c = withConflicts(w);
		c.done('20');
		await c.conflicting('20');
		const listed = c.host.nightjarDrafts;
		w.deps = {
			...w.deps,
			conflicts: {
				drafts: async () => (await listed()).map(({ conflicts: _unsaid, ...draft }) => draft),
				fix: () => Promise.reject(new Error('never'))
			}
		};
		await queue(w.deps, false);
		expect(w.built).toEqual(['2', '4']);
	});

	it('takes a draft once at its head commit in a run, so a fix that pushed nothing does not hold up the Queue', async () => {
		const w = world();
		const c = withConflicts(w);
		c.done('20');
		const pull = await c.conflicting('20');
		c.resolveWith(() =>
			Promise.resolve({
				kind: 'gaveUp',
				pull,
				round: 1,
				why: 'still red',
				usd: 1,
				side: null,
				conflicting: []
			})
		);
		await queue(w.deps, false);
		expect(work(w.trail)).toEqual(['resolve 20', 'build 2', 'build 4']);
	});

	it('takes the draft again once its head commit moved', async () => {
		const w = world();
		await w.tracker.removeSignal('2', 'go');
		await w.tracker.removeSignal('4', 'go');
		const c = withConflicts(w);
		c.done('20');
		const pull = await c.conflicting('20');
		c.resolveWith(() =>
			Promise.resolve({
				kind: 'gaveUp',
				pull,
				round: 1,
				why: 'still red',
				usd: 1,
				side: null,
				conflicting: []
			})
		);
		const { sleep } = w.deps;
		w.deps = {
			...w.deps,
			sleep: async (ms, signal) => {
				await c.host.push('/work/again', 'factory/20-done');
				return sleep(ms, signal);
			}
		};
		await queue(w.deps, false);
		expect(c.resolved).toEqual(['20', '20']);
	});

	it('hands the Feature of a fix that stops on a fault to a person, naming the Conflict fix, and goes on to the Queue', async () => {
		const w = world();
		const c = withConflicts(w);
		c.done('20');
		const pull = await c.conflicting('20');
		c.resolveWith(() => Promise.reject(new Error('the disk is full')));
		await queue({ ...w.deps, signals: DEFAULT_SIGNAL_NAMES }, false);
		expect(w.tracker.signalsOf('20')).toEqual(['needsInfo']);
		const [comment = ''] = w.tracker.said('20');
		expect(comment).toContain(
			'**Waiting on you**: Nightjar stopped on a fault in a Conflict fix: the disk is full.'
		);
		expect(comment).toContain(`The pull request: ${pull.url}`);
		expect(comment).toContain('Nightjar tries a Conflict fix again');
		expect(w.built).toEqual(['2', '4']);
	});

	it('goes on to the Queue when the Code host cannot list the drafts, saying so', async () => {
		const w = world();
		w.deps = {
			...w.deps,
			conflicts: {
				drafts: () => Promise.reject(new Error('the Code host is down')),
				fix: () => Promise.reject(new Error('never'))
			}
		};
		await queue(w.deps, false);
		expect(w.built).toEqual(['2', '4']);
		expect(w.lines.some((l) => l.includes('the Code host is down'))).toBe(true);
	});

	it('pauses as a build does when the fix pauses, and takes the draft again after', async () => {
		const w = world();
		const c = withConflicts(w);
		c.done('20');
		await c.conflicting('20');
		c.resolveWith(() => Promise.resolve({ kind: 'paused', why: 'the daily limit was reached' }));
		await queue(w.deps, false);
		expect(w.sleeps).toEqual([30 * 60_000, 30 * 60_000]);
		expect(c.resolved).toEqual(['20', '20']);
	});

	it('resolves nothing under --once, which builds the next Feature', async () => {
		const w = world();
		const c = withConflicts(w);
		c.done('20');
		await c.conflicting('20');
		expect(await queue(w.deps, true)).toBe(0);
		expect(c.resolved).toEqual([]);
		expect(w.built).toEqual(['2']);
	});
});

describe('conflictsPass', () => {
	const fix = () => Promise.resolve<ConflictFixOutcome>({ kind: 'stopped' });

	it('is there when factory.json turns conflicts on and the Code host lists its drafts', () => {
		expect(conflictsPass({ enabled: true }, new FakeCodeHost(), fix)).not.toBeNull();
	});

	it('is off when factory.json leaves it out or off', () => {
		expect(conflictsPass(undefined, new FakeCodeHost(), fix)).toBeNull();
		expect(conflictsPass({}, new FakeCodeHost(), fix)).toBeNull();
		expect(conflictsPass({ enabled: false }, new FakeCodeHost(), fix)).toBeNull();
	});

	it('is off over a Code host without nightjarDrafts', () => {
		const { nightjarDrafts: _gone, ...without } = new FakeCodeHost();
		expect(conflictsPass({ enabled: true }, without, fix)).toBeNull();
	});
});

describe('queue --once with the Pull-check pass', () => {
	it('fixes the oldest red draft as its one piece of work, builds no Feature and exits', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		d.done('22');
		await d.open('20');
		await d.open('22');
		expect(await queue(w.deps, true)).toBe(0);
		expect(d.fixed).toEqual(['20']);
		expect(w.built).toEqual([]);
		expect(w.sleeps).toEqual([]);
	});

	it('builds the next Feature when no draft is red', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20', { pending: false, failed: [] });
		expect(await queue(w.deps, true)).toBe(0);
		expect(d.fixed).toEqual([]);
		expect(w.built).toEqual(['2']);
	});

	it('builds the next Feature when the draft is not Nightjar to fix after all', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20');
		d.fixWith(() => Promise.resolve({ kind: 'skipped', why: 'its head commit is not Nightjar' }));
		expect(await queue(w.deps, true)).toBe(0);
		expect(d.fixed).toEqual(['20']);
		expect(w.built).toEqual(['2']);
	});

	it('exits 0 when the round gave up and handed the Feature to a person', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		const pull = await d.open('20');
		d.fixWith(() => Promise.resolve({ kind: 'gaveUp', pull, round: 1, why: 'still red', usd: 1 }));
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.built).toEqual([]);
	});

	it('exits 1, saying why, when the daily limit holds the round back, and builds nothing', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20');
		d.fixWith(() => Promise.resolve({ kind: 'paused', why: 'the daily limit was reached' }));
		expect(await queue(w.deps, true)).toBe(1);
		expect(w.lines).toContain('the daily limit was reached');
		expect(w.built).toEqual([]);
	});

	it('builds the next Feature when the Code host cannot list the drafts, saying so', async () => {
		const w = world();
		w.deps = {
			...w.deps,
			pullChecks: {
				drafts: () => Promise.reject(new Error('the Code host is down')),
				fix: () => Promise.reject(new Error('never'))
			}
		};
		expect(await queue(w.deps, true)).toBe(0);
		expect(w.built).toEqual(['2']);
		expect(w.lines.some((l) => l.includes('the Code host is down'))).toBe(true);
	});

	it('takes no draft when the pass is off', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20');
		const { pullChecks: _off, ...off } = w.deps;
		expect(await queue(off, true)).toBe(0);
		expect(d.fixed).toEqual([]);
		expect(w.built).toEqual(['2']);
	});
});

// every promise the fakes chain settles before the next macrotask
const settle = () => new Promise<void>((done) => setImmediate(done));

// The world with `slots` Slots: each build, fix and Feedback round held until the spec ends it, and each sleep until the spec wakes it or the run stops.
function slotted(w: ReturnType<typeof world>, slots: number) {
	const stop = new AbortController();
	const held = new Map<string, (end: FeatureOutcome) => void>();
	const naps: { ms: number; wake: () => void }[] = [];
	const hold = (id: string) => new Promise<FeatureOutcome>((end) => held.set(id, end));
	w.deps = {
		...w.deps,
		slots,
		signal: stop.signal,
		build: async ({ id }, say) => {
			w.built.push(id);
			w.trail.push(`build ${id}`);
			await w.tracker.removeSignal(id, 'go');
			say('building');
			return hold(id);
		},
		sleep: (ms, signal) =>
			new Promise<void>((wake) => {
				naps.push({ ms, wake });
				signal?.addEventListener('abort', () => wake(), { once: true });
			})
	};
	return {
		stop,
		naps,
		hold,
		running: () => [...held.keys()],
		end: async (id: string, outcome: FeatureOutcome = { kind: 'nothing', waiting: [] }) => {
			const end = held.get(id);
			held.delete(id);
			end?.(outcome);
			await settle();
		},
		// the last sleep ends, as the next tick would
		tick: async () => {
			naps.at(-1)?.wake();
			await settle();
		}
	};
}

// A Feedback pass over one open pull request on Feature 30's branch, whose newest request for changes is `request`; each round held.
function asking(w: ReturnType<typeof world>, s: ReturnType<typeof slotted>) {
	w.tracker.add({ id: '30', title: 'Asked', assignees: ['ann'], children: ['31'] });
	w.tracker.add({ id: '31', title: 'Ticket 31' });
	let request = 'review:1';
	const answered: string[] = [];
	const open = (): OpenPull => ({
		pull: { id: 30, url: 'https://example.test/o/app/pull/30' },
		branch: branchFor('30', 'Asked'),
		body: `Nightjar built it.\n\n${featureMarker('30')}`,
		commits: [],
		changesRequested: [{ id: request, author: 'rae', at: '2026-10-30T08:00:00Z', trusted: true }]
	});
	w.deps = {
		...w.deps,
		feedback: {
			pulls: () => Promise.resolve([open()]),
			answer: ({ id }, _asked, say) => {
				answered.push(id);
				w.trail.push(`answer ${id}`);
				say('answering');
				return s.hold(id);
			}
		}
	};
	return {
		answered,
		askAgain: (id: string) => {
			request = id;
		}
	};
}

describe('queue with several Slots', () => {
	function three() {
		const w = world();
		w.tracker.add({
			id: '10',
			title: 'Third',
			assignees: ['ann'],
			signals: ['go'],
			children: ['11']
		});
		w.tracker.add({ id: '11', title: 'Ticket 11' });
		return w;
	}

	it('builds two Features at once with two Slots, and starts the third when one ends', async () => {
		const w = three();
		const s = slotted(w, 2);
		const run = queue(w.deps, false);
		await settle();
		expect(s.running()).toEqual(['2', '4']);
		await s.end('4');
		expect(s.running()).toEqual(['2', '10']);
		expect(w.built).toEqual(['2', '4', '10']);
		s.stop.abort();
		await s.end('2');
		await s.end('10');
		expect(await run).toBe(130);
	});

	it('never takes a red draft of a Feature being built in another Slot', async () => {
		const w = world();
		const s = slotted(w, 2);
		const d = withDrafts(w);
		// red from the start, and left alone while Feature 2 holds the Go
		await d.open('2');
		const run = queue(w.deps, false);
		await settle();
		expect(d.fixed).toEqual([]);
		expect(s.running()).toEqual(['2', '4']);
		await s.end('2');
		expect(d.fixed).toEqual(['2']);
		s.stop.abort();
		await s.end('4');
		await run;
	});

	it('never starts a Feedback round on a Feature in a Slot, even on a newer request for changes', async () => {
		const w = world();
		await w.tracker.removeSignal('2', 'go');
		await w.tracker.removeSignal('4', 'go');
		const s = slotted(w, 2);
		const f = asking(w, s);
		const run = queue(w.deps, false);
		await settle();
		expect(f.answered).toEqual(['30']);
		f.askAgain('review:2');
		await s.tick();
		expect(f.answered).toEqual(['30']);
		s.stop.abort();
		await s.end('30');
		await run;
	});

	it('fills a free Slot with a red draft first, then a Feature with the Go, then a Feedback round', async () => {
		const w = world();
		const s = slotted(w, 2);
		const d = withDrafts(w);
		d.done('20');
		const pull = await d.open('20');
		d.fixWith(async () => {
			await s.hold('20');
			return { kind: 'fixed', pull, round: 1, summary: 'Fixed.', usd: 1 };
		});
		const f = asking(w, s);
		const run = queue(w.deps, false);
		await settle();
		expect(work(w.trail)).toEqual(['fix 20', 'build 2']);
		await s.end('2');
		expect(work(w.trail)).toEqual(['fix 20', 'build 2', 'build 4']);
		await s.end('20');
		expect(work(w.trail)).toEqual(['fix 20', 'build 2', 'build 4', 'answer 30']);
		expect(f.answered).toEqual(['30']);
		s.stop.abort();
		await s.end('4');
		await s.end('30');
		await run;
	});

	it('--once takes up to its Slots and returns once every one has ended', async () => {
		const w = world();
		const s = slotted(w, 3);
		let returned: number | null = null;
		const run = queue(w.deps, true).then((code) => (returned = code));
		await settle();
		expect(s.running()).toEqual(['2', '4']);
		await s.end('2');
		expect(returned).toBeNull();
		await s.end('4');
		await run;
		expect(returned).toBe(0);
		expect(w.built).toEqual(['2', '4']);
		expect(s.naps).toEqual([]);
	});

	it('--once exits 1 when any of its Slots does not end well', async () => {
		const w = world();
		const s = slotted(w, 2);
		const run = queue(w.deps, true);
		await settle();
		await s.end('2');
		expect(s.running()).toEqual(['4']);
		await s.end('4', { kind: 'paused', why: 'the daily limit was reached' });
		expect(await run).toBe(1);
	});

	it('looks again on each tick while a Slot is free, and checks for newer code only once every Slot is empty', async () => {
		const w = world();
		await w.tracker.removeSignal('4', 'go');
		const s = slotted(w, 2);
		let checked = 0;
		w.deps = { ...w.deps, newer: () => ((checked += 1), Promise.resolve(null)) };
		const run = queue(w.deps, false);
		await settle();
		expect(s.naps.map((n) => n.ms)).toEqual([120_000]);
		await w.tracker.addSignal('4', 'go');
		await s.tick();
		expect(s.running()).toEqual(['2', '4']);
		expect(checked).toBe(0);
		await s.end('2');
		await s.end('4');
		expect(checked).toBe(1);
		expect(w.doing.at(-1)).toMatchObject({ kind: 'idle' });
		s.stop.abort();
		await run;
	});

	it('pauses every Slot when one pauses: none takes work until the pause ends, and the running ones finish', async () => {
		const w = three();
		const s = slotted(w, 2);
		const run = queue(w.deps, false);
		await settle();
		await s.end('2', { kind: 'paused', why: 'the daily limit was reached' });
		expect(s.running()).toEqual(['4']);
		expect(w.doing.at(-1)).toMatchObject({ kind: 'paused', why: 'the daily limit was reached' });
		expect(s.naps.map((n) => n.ms)).toEqual([30 * 60_000]);
		await s.end('4');
		expect(w.built).toEqual(['2', '4']);
		await s.tick();
		expect(s.running()).toEqual(['10']);
		s.stop.abort();
		await s.end('10');
		await run;
	});

	describe("on the plan's usage limit", () => {
		const LIMIT = "the plan's usage limit was reached";
		// the world's clock reads 2026-10-30 09:00 local
		const at = (minutes: number) => new Date(2026, 9, 30, 9, minutes);
		const epoch = (minutes: number) => Math.floor(at(minutes).getTime() / 1000);
		// four Features with the Go, so that two Slots have work after a pause
		function four() {
			const w = three();
			w.tracker.add({
				id: '12',
				title: 'Fourth',
				assignees: ['ann'],
				signals: ['go'],
				children: ['13']
			});
			w.tracker.add({ id: '13', title: 'Ticket 13' });
			return w;
		}

		it('resumes every Slot together at the time the limit gave, and both take work again', async () => {
			const w = four();
			const s = slotted(w, 2);
			const run = queue(w.deps, false);
			await settle();
			await s.end('2', { kind: 'paused', why: LIMIT, resetsAt: epoch(45) });
			// no claim in either Slot while the pause lasts, though one is free
			await settle();
			expect(s.running()).toEqual(['4']);
			expect(s.naps.map((n) => n.ms)).toEqual([45 * 60_000]);
			expect(w.doing.at(-1)).toEqual({
				kind: 'paused',
				why: LIMIT,
				until: at(45).toISOString()
			});
			await s.end('4');
			expect(s.running()).toEqual([]);
			expect(w.built).toEqual(['2', '4']);
			s.naps[0]?.wake();
			await settle();
			expect(s.running()).toEqual(['10', '12']);
			s.stop.abort();
			await s.end('10');
			await s.end('12');
			await run;
		});

		it('resumes after PAUSE_MS when the limit gave no reset time, or one already past', async () => {
			for (const resetsAt of [undefined, epoch(-5)]) {
				const w = four();
				const s = slotted(w, 2);
				const run = queue(w.deps, false);
				await settle();
				await s.end('2', {
					kind: 'paused',
					why: LIMIT,
					...(resetsAt === undefined ? {} : { resetsAt })
				});
				expect(s.naps.map((n) => n.ms)).toEqual([PAUSE_MS]);
				expect(w.doing.at(-1)).toMatchObject({ kind: 'paused', until: at(30).toISOString() });
				await s.end('4');
				s.naps[0]?.wake();
				await settle();
				expect(s.running()).toEqual(['10', '12']);
				s.stop.abort();
				await s.end('10');
				await s.end('12');
				await run;
			}
		});

		it('pauses the run when a Session ends on the limit after its pull request was opened', async () => {
			const w = three();
			const s = slotted(w, 2);
			const run = queue(w.deps, false);
			await settle();
			const pull = { id: 7, url: 'https://example.test/o/app/pull/7' };
			await s.end('2', {
				kind: 'pull',
				pull,
				built: ['3'],
				waiting: [],
				pause: { why: LIMIT, resetsAt: epoch(45) }
			});
			expect(s.running()).toEqual(['4']);
			expect(s.naps.map((n) => n.ms)).toEqual([45 * 60_000]);
			await settle();
			expect(s.running()).toEqual(['4']);
			s.stop.abort();
			await s.end('4');
			await run;
		});

		it('keeps the first pause when a second Session ends on the limit during it', async () => {
			const w = three();
			const s = slotted(w, 2);
			const run = queue(w.deps, false);
			await settle();
			await s.end('2', { kind: 'paused', why: LIMIT, resetsAt: epoch(45) });
			await s.end('4', { kind: 'paused', why: LIMIT, resetsAt: epoch(90) });
			expect(s.naps.map((n) => n.ms)).toEqual([45 * 60_000]);
			s.stop.abort();
			await run;
		});

		it('--once ends on the pause and takes no more work', async () => {
			const w = three();
			const s = slotted(w, 2);
			const run = queue(w.deps, true);
			await settle();
			await s.end('2', { kind: 'paused', why: LIMIT, resetsAt: epoch(45) });
			await s.end('4');
			expect(await run).toBe(1);
			expect(w.built).toEqual(['2', '4']);
			expect(s.naps).toEqual([]);
		});
	});

	it('on abort takes no more work, and returns 130 once every running Slot has ended', async () => {
		const w = three();
		const s = slotted(w, 2);
		let returned: number | null = null;
		const run = queue(w.deps, false).then((code) => (returned = code));
		await settle();
		s.stop.abort();
		await s.end('2', { kind: 'stopped' });
		expect(returned).toBeNull();
		expect(s.running()).toEqual(['4']);
		await s.end('4', { kind: 'stopped' });
		await run;
		expect(returned).toBe(130);
		expect(w.built).toEqual(['2', '4']);
	});

	it("starts each line a Slot's work says with its Feature's id", async () => {
		const w = world();
		const s = slotted(w, 2);
		const run = queue(w.deps, false);
		await settle();
		expect(w.lines).toEqual(['#2: building', '#4: building']);
		s.stop.abort();
		await s.end('2');
		await s.end('4');
		await run;
	});

	it('leaves the lines as they are with one Slot', async () => {
		const w = world();
		const s = slotted(w, 1);
		const run = queue(w.deps, false);
		await settle();
		expect(w.lines).toEqual(['building']);
		s.stop.abort();
		await s.end('2');
		await run;
	});
});

describe('queue with reserved ports', () => {
	// A pool of `blocks` blocks of ports on the slotted world's deps: each claim takes one, each release gives it back, and each build's portEnv is kept.
	function pooled(w: ReturnType<typeof world>, blocks: number) {
		const free = Array.from({ length: blocks }, (_, i) => 4500 + 2 * i);
		const seen = new Map<string, PortEnv | undefined>();
		const inner = w.deps.build;
		w.deps = {
			...w.deps,
			claimPorts: () => {
				const first = free.shift();
				return Promise.resolve(
					first === undefined
						? null
						: {
								env: { WEB_PORT: String(first), DB_PORT: String(first + 1) },
								ports: `${String(first)} to ${String(first + 1)}`,
								release: () => void free.push(first)
							}
				);
			},
			build: (feature, say, portEnv) => {
				seen.set(feature.id, portEnv);
				return inner(feature, say, portEnv);
			}
		};
		return { seen, free };
	}

	function three() {
		const w = world();
		w.tracker.add({
			id: '10',
			title: 'Third',
			assignees: ['ann'],
			signals: ['go'],
			children: ['11']
		});
		w.tracker.add({ id: '11', title: 'Ticket 11' });
		return w;
	}

	it('gives two Slots building at once two blocks that do not overlap', async () => {
		const w = world();
		const s = slotted(w, 2);
		const p = pooled(w, 2);
		const run = queue(w.deps, false);
		await settle();
		expect(s.running()).toEqual(['2', '4']);
		expect(p.seen.get('2')).toEqual({ WEB_PORT: '4500', DB_PORT: '4501' });
		expect(p.seen.get('4')).toEqual({ WEB_PORT: '4502', DB_PORT: '4503' });
		expect(w.lines).toContain('#2: ports 4500 to 4501');
		expect(w.lines).toContain('#4: ports 4502 to 4503');
		s.stop.abort();
		await s.end('2');
		await s.end('4');
		await run;
	});

	it("gives a block back when its Slot's work ends, and the next work claims it", async () => {
		const w = three();
		const s = slotted(w, 2);
		const p = pooled(w, 2);
		const run = queue(w.deps, false);
		await settle();
		await s.end('4');
		expect(s.running()).toEqual(['2', '10']);
		expect(p.seen.get('10')).toEqual({ WEB_PORT: '4502', DB_PORT: '4503' });
		s.stop.abort();
		await s.end('2');
		await s.end('10');
		await run;
		expect(p.free.sort()).toEqual([4500, 4502]);
	});

	it('gives a block back when the work ends on a fault', async () => {
		const w = world();
		const p = pooled(w, 1);
		w.failWith(new Error('the network went away'));
		await queue(w.deps, true);
		expect(p.free).toEqual([4500]);
	});

	it('takes no work for a Slot with no block free, says why once, and goes on', async () => {
		const w = world();
		const s = slotted(w, 2);
		const p = pooled(w, 1);
		const run = queue(w.deps, false);
		await settle();
		expect(s.running()).toEqual(['2']);
		expect(w.built).toEqual(['2']);
		const waits = () => w.lines.filter((l) => l.startsWith('#4 waits: no block of reserved ports'));
		expect(waits()).toHaveLength(1);
		// the next tick looks again and says nothing more
		await s.tick();
		expect(s.running()).toEqual(['2']);
		expect(waits()).toHaveLength(1);
		// the other Slot's block comes back, and the Slot takes the work at once
		await s.end('2');
		expect(s.running()).toEqual(['4']);
		expect(p.seen.get('4')).toEqual({ WEB_PORT: '4500', DB_PORT: '4501' });
		s.stop.abort();
		await s.end('4');
		await run;
	});

	it('puts a Feedback round back when no block is free, so a later tick starts it', async () => {
		const w = world();
		await w.tracker.removeSignal('2', 'go');
		await w.tracker.removeSignal('4', 'go');
		const s = slotted(w, 1);
		const f = asking(w, s);
		const p = pooled(w, 0);
		const run = queue(w.deps, false);
		await settle();
		expect(f.answered).toEqual([]);
		p.free.push(4500);
		await s.tick();
		expect(f.answered).toEqual(['30']);
		s.stop.abort();
		await s.end('30');
		await run;
	});

	it('--once exits 2 when no block is free for the one Feature it would take', async () => {
		const w = world();
		pooled(w, 0);
		expect(await queue(w.deps, true)).toBe(2);
		expect(w.built).toEqual([]);
		expect(w.lines.some((l) => l.startsWith('#2 waits: no block of reserved ports'))).toBe(true);
	});

	it('claims none when the repo reserves no ports, as before', async () => {
		const w = world();
		const seen: (PortEnv | undefined)[] = [];
		const inner = w.deps.build;
		w.deps = {
			...w.deps,
			build: (feature, say, portEnv) => (seen.push(portEnv), inner(feature, say, portEnv))
		};
		await queue(w.deps, true);
		expect(seen).toEqual([undefined]);
		expect(w.lines.some((l) => l.includes('ports'))).toBe(false);
	});
});

describe('slotSay', () => {
	it("leaves a line that starts with the Feature's id, and marks every other", () => {
		const lines: string[] = [];
		const say = slotSay('2', (l) => lines.push(l));
		say('#2 Older: building on factory/2-older');
		say('#2: draft pull request https://example.test/o/app/pull/1');
		say('#20 Ticket: session s-1');
		say('paused: the daily limit was reached');
		expect(lines).toEqual([
			'#2 Older: building on factory/2-older',
			'#2: draft pull request https://example.test/o/app/pull/1',
			'#2: #20 Ticket: session s-1',
			'#2: paused: the daily limit was reached'
		]);
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

describe('a lone issue', () => {
	function loneWorld() {
		const w = world();
		w.tracker.add({ id: '20', title: 'Fix a typo', assignees: ['ann'], signals: ['go'] });
		// a Ticket of Feature #2 that carries the Go: its Feature owns it
		w.tracker.add({ id: '3', title: 'Ticket 3', assignees: ['ann'], signals: ['go'] });
		return w;
	}

	it('is built by --once and --watch in its place in the Queue, and its parent-owned Ticket is not', async () => {
		const w = loneWorld();
		await queue(w.deps, true);
		await queue(w.deps, true);
		await queue(w.deps, true);
		expect(w.built).toEqual(['2', '4', '20']);
	});

	it('is refused by nightjar <id> when it is a Ticket of a Feature, naming the Feature', async () => {
		const w = loneWorld();
		expect(await cannotClaim(w.deps, '3')).toBe(
			'#3 is a Ticket of #2, so that Feature owns it and Nightjar leaves it alone. Build #2 instead.'
		);
		expect(await cannotClaim(w.deps, '20')).toBeNull();
	});

	it('is listed by doctor with the Features it would build, marked as a lone issue', async () => {
		const w = loneWorld();
		await dryRun(w.deps);
		expect(w.lines).toEqual([
			'would build #2 Older',
			'would build #4 Later',
			'would build #20 Fix a typo (a lone issue)'
		]);
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

describe('dryRun with Publish', () => {
	it('lists a draft it would publish as it lists feedback it would answer, and publishes nothing', async () => {
		const w = world();
		const p = withPublish(w);
		w.tracker.add({ id: '20', title: 'Done 20', assignees: ['ann'] });
		const ready = await p.open('20');
		p.host.setChecks(await p.open('22'), { pending: true, failed: [] });
		await dryRun({
			...w.deps,
			...(w.deps.publish === undefined ? {} : { publish: w.deps.publish })
		});
		expect(w.lines).toEqual([
			'would build #2 Older',
			'would build #4 Later',
			`would publish #20 Done 20, on ${ready.url}`
		]);
		expect(p.published).toEqual([]);
		expect(p.draftOf(ready)).toBe(true);
	});

	it('says it has nothing to do only when it has no draft to publish either', async () => {
		const w = world();
		const p = withPublish(w);
		await w.tracker.removeSignal('2', 'go');
		await w.tracker.removeSignal('4', 'go');
		w.tracker.add({ id: '20', title: 'Done 20', assignees: ['ann'] });
		const ready = await p.open('20');
		await dryRun({
			...w.deps,
			...(w.deps.publish === undefined ? {} : { publish: w.deps.publish })
		});
		expect(w.lines).toEqual([`would publish #20 Done 20, on ${ready.url}`]);
	});

	it('lists nothing to publish when the pass is off', async () => {
		const w = world();
		await dryRun(w.deps);
		expect(w.lines.some((l) => l.startsWith('would publish'))).toBe(false);
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

describe('the exit code of nightjar <id>', () => {
	const pull = { id: 7, url: 'https://code.example/pull/7' };

	it('is 0 for a Feature handed to a person after a push a person beat', () => {
		expect(featureExit({ kind: 'diverged', side: 'factory/4-x-attempt-push' })).toBe(0);
		expect(
			pullFixExit({ kind: 'diverged', pull, round: 1, side: 'factory/4-x-attempt-push', usd: 1 })
		).toBe(0);
	});

	it('is 0 for a pull request opened or nothing to build, and 1 for a run that went no further', () => {
		expect(featureExit({ kind: 'nothing', waiting: [] })).toBe(0);
		expect(featureExit({ kind: 'paused', why: 'the daily limit was reached' })).toBe(1);
		expect(featureExit({ kind: 'stopped' })).toBe(1);
		expect(featureExit(null)).toBe(1);
	});

	it('is 1 for a Pull-check fix whose push faulted', () => {
		const faulted: PullFixOutcome = {
			kind: 'faulted',
			pull,
			round: 1,
			fault: new Error('x'),
			title: 'T',
			usd: 1
		};
		expect(pullFixExit(faulted)).toBe(1);
	});
});

describe('nightjar <id> with the Pull-check pass', () => {
	it("fixes that Feature's red draft, not another Feature's, even when an older one is red", async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		d.done('22');
		await d.open('20');
		await d.open('22');
		const got = await fixNamed(w.deps, '22');
		expect(got).toMatchObject({ kind: 'fixed' });
		expect(d.fixed).toEqual(['22']);
		expect(w.built).toEqual([]);
		expect(got === null ? 1 : pullFixExit(got)).toBe(0);
	});

	it('leaves the Feature to be built as today when it has no red draft', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20', { pending: false, failed: [] });
		d.done('22');
		await d.open('22');
		expect(await fixNamed(w.deps, '20')).toBeNull();
		expect(await fixNamed(w.deps, '4')).toBeNull();
		expect(d.fixed).toEqual([]);
	});

	it('leaves the Feature to be built when the round skipped its draft', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20');
		d.fixWith(() => Promise.resolve({ kind: 'skipped', why: 'nothing to resume' }));
		expect(await fixNamed(w.deps, '20')).toBeNull();
	});

	it('exits 1, saying why, when the daily limit holds the round back', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20');
		d.fixWith(() => Promise.resolve({ kind: 'paused', why: 'the daily limit was reached' }));
		const got = await fixNamed(w.deps, '20');
		expect(got === null ? 0 : pullFixExit(got)).toBe(1);
		expect(w.lines).toContain('the daily limit was reached');
	});

	it('does nothing when the pass is off', async () => {
		const w = world();
		const d = withDrafts(w);
		d.done('20');
		await d.open('20');
		const { pullChecks: _off, ...off } = w.deps;
		expect(await fixNamed(off, '20')).toBeNull();
		expect(d.fixed).toEqual([]);
	});
});

// Draft pull requests on a fake Code host whose Pull checks, Review mark and people a spec plays, with the Publish pass over it.
function withPublish(w: ReturnType<typeof world>) {
	const host = new FakeCodeHost();
	const pass = publishPass(true, host);
	if (pass === null) throw new Error('the fake Code host cannot publish');
	const published: string[] = [];
	// minutes after the newest pull request opened; the fake has its own clock
	let minutes = 0;
	const clock = () => {
		const opened = Math.max(0, ...host.pulls.map((p) => Date.parse(p.openedAt)));
		return new Date(opened + minutes * 60_000);
	};
	w.deps = {
		...w.deps,
		now: clock,
		publish: {
			...pass,
			publish: async (draft) => {
				w.trail.push(`publish ${String(draft.pull.id)}`);
				published.push(draft.pull.url);
				await pass.publish(draft);
			}
		}
	};
	const open = async (
		feature: string,
		{
			mark = { complete: true, approved: true },
			checks = { pending: false, failed: [] },
			ran = true
		}: {
			mark?: PublishMark | null;
			checks?: PullChecks;
			// whether any Pull check ran on the head commit
			ran?: boolean;
		} = {}
	) => {
		const branch = `factory/${feature}-done`;
		await host.push(`/work/${branch}`, branch);
		const marked = mark === null ? '' : `\n${publishMark(mark)}`;
		const body = `Nightjar built all of it.\n\n${featureMarker(feature)}${marked}`;
		const pull = await host.createDraft({ title: 'Done', head: branch, base: 'main', body });
		host.setChecks(pull, checks, ran);
		return pull;
	};
	const draftOf = (pull: { id: number }) => host.pulls.find((p) => p.id === pull.id)?.draft;
	return {
		host,
		open,
		published,
		draftOf,
		later: (m: number) => {
			minutes = m;
		}
	};
}

describe('queue --watch with Publish', () => {
	it('publishes a draft whose Feature was complete, whose last Review approved and whose Pull checks finished green, before it takes the next Feature', async () => {
		const w = world();
		const p = withPublish(w);
		const pull = await p.open('20');
		await queue(w.deps, false);
		expect(p.draftOf(pull)).toBe(false);
		expect(w.lines).toContain(`published ${pull.url}`);
		expect(work(w.trail)).toEqual([`publish ${String(pull.id)}`, 'build 2', 'build 4']);
	});

	it('publishes the oldest first, and the next before any Feature', async () => {
		const w = world();
		const p = withPublish(w);
		const first = await p.open('20');
		const second = await p.open('22');
		await queue(w.deps, false);
		expect(p.published).toEqual([first.url, second.url]);
		expect(work(w.trail).slice(2)).toEqual(['build 2', 'build 4']);
	});

	it('looks again on each idle tick, so a draft whose Pull checks finish while nothing is queued is published', async () => {
		const w = world();
		await w.tracker.removeSignal('2', 'go');
		await w.tracker.removeSignal('4', 'go');
		const p = withPublish(w);
		const pull = await p.open('20', { checks: { pending: true, failed: [] } });
		const { sleep } = w.deps;
		w.deps = {
			...w.deps,
			sleep: (ms, signal) => {
				p.host.setChecks(pull, { pending: false, failed: [] });
				return sleep(ms, signal);
			}
		};
		await queue(w.deps, false);
		expect(p.draftOf(pull)).toBe(false);
	});

	it.each([
		['a partial Feature', { mark: { complete: false, approved: true } }],
		['a last Review that said changes', { mark: { complete: true, approved: false } }],
		['a body with no mark', { mark: null }],
		['Pull checks still running', { checks: { pending: true, failed: [] } }],
		['Pull checks that finished red', { checks: { pending: false, failed: [FAILURE] } }]
	] as const)('leaves a draft with %s as it is', async (_name, over) => {
		const w = world();
		const p = withPublish(w);
		const pull = await p.open('20', over);
		await queue(w.deps, false);
		expect(p.draftOf(pull)).toBe(true);
		expect(p.published).toEqual([]);
		expect(w.built).toEqual(['2', '4']);
	});

	it('leaves a draft a person engaged with, pushed to or closed as it is', async () => {
		const w = world();
		const p = withPublish(w);
		const engaged = await p.open('20');
		p.host.engage(engaged);
		const pushed = await p.open('22');
		p.host.pushedByPerson(pushed);
		const closed = await p.open('24');
		p.host.close(closed);
		await queue(w.deps, false);
		expect(p.published).toEqual([]);
		expect(p.draftOf(engaged)).toBe(true);
		expect(p.draftOf(pushed)).toBe(true);
	});

	it('waits for Pull checks the Code host has not registered until 10 minutes after the pull request opened, then takes none as green', async () => {
		const w = world();
		const p = withPublish(w);
		const pull = await p.open('20', { ran: false });
		p.later(9);
		const seen: (boolean | undefined)[] = [];
		const { sleep } = w.deps;
		w.deps = {
			...w.deps,
			sleep: (ms, signal) => {
				seen.push(p.draftOf(pull));
				p.later(10);
				return sleep(ms, signal);
			}
		};
		await queue(w.deps, false);
		expect(seen[0]).toBe(true);
		expect(p.draftOf(pull)).toBe(false);
	});

	it('does not wait when Pull checks ran and finished green', async () => {
		const w = world();
		const p = withPublish(w);
		const pull = await p.open('20');
		p.later(0);
		await queue(w.deps, false);
		expect(p.draftOf(pull)).toBe(false);
	});

	it('publishes with the Pull-check pass off, which it needs no part of', async () => {
		const w = world();
		const p = withPublish(w);
		const pull = await p.open('20');
		expect(w.deps.pullChecks).toBeUndefined();
		await queue(w.deps, false);
		expect(p.draftOf(pull)).toBe(false);
	});

	it('publishes nothing under --once', async () => {
		const w = world();
		const p = withPublish(w);
		const pull = await p.open('20');
		await queue(w.deps, true);
		expect(p.draftOf(pull)).toBe(true);
		expect(w.built).toEqual(['2']);
	});

	it('publishes a pull request once, and never makes it a draft again', async () => {
		const w = world();
		const p = withPublish(w);
		const pull = await p.open('20');
		await queue(w.deps, false);
		expect(w.sleeps.length).toBe(2);
		expect(p.published).toEqual([pull.url]);
		expect(p.draftOf(pull)).toBe(false);
	});

	it('goes on to the Queue when publishing stops on a fault, saying so, and does not try that pull request again in the run', async () => {
		const w = world();
		const p = withPublish(w);
		const pull = await p.open('20');
		let tries = 0;
		const { publish } = w.deps;
		if (publish === undefined) throw new Error('no publish pass');
		w.deps = {
			...w.deps,
			publish: {
				...publish,
				publish: () => {
					tries += 1;
					return Promise.reject(new Error('the Code host is down'));
				}
			}
		};
		await queue(w.deps, false);
		expect(tries).toBe(1);
		expect(p.draftOf(pull)).toBe(true);
		expect(w.built).toEqual(['2', '4']);
		expect(
			w.lines.some((l) => l.includes(`could not publish ${pull.url}: the Code host is down`))
		).toBe(true);
	});

	it('goes on to the Queue when the Code host cannot list the drafts, saying so', async () => {
		const w = world();
		w.deps = {
			...w.deps,
			publish: {
				drafts: () => Promise.reject(new Error('the Code host is down')),
				publish: () => Promise.reject(new Error('never'))
			}
		};
		await queue(w.deps, false);
		expect(w.built).toEqual(['2', '4']);
		expect(w.lines.some((l) => l.includes('the Code host is down'))).toBe(true);
	});
});

describe('queue --watch with Publish and the Pull-check pass', () => {
	// both passes over one Code host
	function both(w: ReturnType<typeof world>) {
		const p = withPublish(w);
		const fixed: string[] = [];
		w.deps = {
			...w.deps,
			pullChecks: {
				drafts: p.host.nightjarDrafts,
				fix: (red) => {
					fixed.push(red.feature);
					return Promise.resolve({ kind: 'skipped', why: 'a spec' });
				}
			}
		};
		return { ...p, fixed };
	}

	it('still fixes a pull request Nightjar published when its Pull checks go red', async () => {
		const w = world();
		const p = both(w);
		w.tracker.add({ id: '20', title: 'Done 20', assignees: ['ann'] });
		const pull = await p.open('20');
		const { sleep } = w.deps;
		w.deps = {
			...w.deps,
			sleep: (ms, signal) => {
				p.host.setChecks(pull, { pending: false, failed: [FAILURE] });
				return sleep(ms, signal);
			}
		};
		await queue(w.deps, false);
		expect(p.draftOf(pull)).toBe(false);
		expect(p.fixed).toEqual(['20']);
	});

	it('stops once a person engages with it', async () => {
		const w = world();
		const p = both(w);
		w.tracker.add({ id: '20', title: 'Done 20', assignees: ['ann'] });
		const pull = await p.open('20');
		const { sleep } = w.deps;
		w.deps = {
			...w.deps,
			sleep: (ms, signal) => {
				p.host.engage(pull);
				p.host.setChecks(pull, { pending: false, failed: [FAILURE] });
				return sleep(ms, signal);
			}
		};
		await queue(w.deps, false);
		expect(p.fixed).toEqual([]);
	});

	it('leaves a pull request a person marked ready alone, red or not', async () => {
		const w = world();
		const p = both(w);
		w.tracker.add({ id: '20', title: 'Done 20', assignees: ['ann'] });
		const pull = await p.open('20', { checks: { pending: false, failed: [FAILURE] } });
		p.host.markReady(pull);
		await queue(w.deps, false);
		expect(p.fixed).toEqual([]);
		expect(p.published).toEqual([]);
	});
});

describe('publishPass', () => {
	it('is there when factory.json sets publish and the Code host can publish and list its drafts', () => {
		expect(publishPass(true, new FakeCodeHost())).not.toBeNull();
	});

	it('is off when factory.json leaves publish out or off', () => {
		expect(publishPass(undefined, new FakeCodeHost())).toBeNull();
		expect(publishPass(false, new FakeCodeHost())).toBeNull();
	});

	it('is off over a Code host without publish or without nightjarDrafts', () => {
		const { publish: _no, ...noPublish } = new FakeCodeHost();
		expect(publishPass(true, noPublish)).toBeNull();
		const { nightjarDrafts: _gone, ...noDrafts } = new FakeCodeHost();
		expect(publishPass(true, noDrafts)).toBeNull();
	});
});
