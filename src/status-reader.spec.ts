import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileSpend, record } from './ledger.js';
import { fileLogbook } from './logbook.js';
import { readFactory } from './status-reader.js';
import { StatusFile } from './status.js';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-reader-'));
	mkdirSync(join(root, '.factory', 'logs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = new Date(2026, 9, 30, 9, 0);
const live = () => true;
const dead = () => false;

const status = () =>
	new StatusFile({
		path: join(root, '.factory', 'status.json'),
		spend: fileSpend(join(root, '.factory', 'runs.jsonl')),
		now: () => at,
		pid: 42,
		dailyUsd: 60
	});

const building = (session: string | null) =>
	({
		kind: 'building',
		feature: '1',
		ticket: '2',
		step: 'build',
		round: 1,
		rounds: 3,
		session,
		startedAt: at.toISOString()
	}) as const;

const log = (session: string, lines: readonly unknown[]) =>
	writeFileSync(
		join(root, '.factory', 'logs', `${session}.jsonl`),
		lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
	);

const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });

const ledger = (feature: string | number, costUsd: number, when = at) =>
	record(join(root, '.factory', 'runs.jsonl'), {
		at: when.toISOString(),
		repo: 'o/r',
		feature: feature as string,
		ticket: null,
		branch: 'b',
		step: 'build',
		session: 's',
		costUsd,
		outcome: 'built'
	});

describe('readFactory', () => {
	it('reads no status.json as none, with nothing to show', () => {
		expect(readFactory(root, { alive: live })).toEqual({
			status: null,
			stopped: false,
			tail: [],
			completed: [],
			builds: [],
			featureCostUsd: 0,
			builtToday: 0,
			week: { completed: 0, failed: 0, handed: 0, spentUsd: 0 },
			medianTicketMs: null
		});
	});

	it('reads the last seven days from the ledger, the finished runs and the hand-backs, and no more', () => {
		const now = new Date(2026, 9, 30, 9, 0);
		const ledgerFile = join(root, '.factory', 'runs.jsonl');
		const lineAt = (when: Date, costUsd: number) =>
			record(ledgerFile, {
				at: when.toISOString(),
				repo: 'o/r',
				feature: '1',
				ticket: null,
				branch: 'b',
				step: 'build',
				session: 's',
				costUsd,
				outcome: 'built'
			});
		lineAt(new Date(2026, 9, 23, 23, 0), 50);
		lineAt(new Date(2026, 9, 24, 0, 0), 1);
		lineAt(new Date(2026, 9, 30, 8, 0), 2);
		const statusAt = (when: Date) =>
			new StatusFile({
				path: join(root, '.factory', 'status.json'),
				spend: fileSpend(ledgerFile),
				now: () => when,
				pid: 1,
				dailyUsd: 8
			});
		statusAt(new Date(2026, 9, 22, 12)).happened({ kind: 'pull', feature: '7', url: 'u' });
		statusAt(new Date(2026, 9, 26, 12)).happened({ kind: 'pull', feature: '8', url: 'u' });
		statusAt(new Date(2026, 9, 27, 12)).happened({ kind: 'failed', feature: '9', why: 'red' });
		statusAt(new Date(2026, 9, 28, 12)).happened({
			kind: 'needs-info',
			feature: '10',
			ticket: '11',
			why: 'needs info'
		});
		expect(readFactory(root, { alive: live, now: () => now }).week).toEqual({
			completed: 1,
			failed: 1,
			handed: 1,
			spentUsd: 3
		});
	});

	it("adds up the current Feature's cost and the Tickets built today, from the ledger", () => {
		ledger('1', 1.5);
		ledger('1', 0.25);
		ledger('2', 9);
		status().doing(building(null));
		const view = readFactory(root, { alive: live, now: () => at });
		expect(view.featureCostUsd).toBe(1.75);
		expect(view.builtToday).toBe(3);
		status().doing({ kind: 'off' });
		expect(readFactory(root, { alive: live, now: () => at }).featureCostUsd).toBe(0);
	});

	it("gives each busy Slot's build its own Session tail and cost, oldest first", () => {
		ledger('1', 1.5);
		ledger('3', 0.5);
		log('one', [assistant({ type: 'text', text: 'from one' })]);
		log('three', [assistant({ type: 'text', text: 'from three' })]);
		const file = status();
		file.doing(building('one'));
		file.doing({ ...building('three'), feature: '3' });
		const view = readFactory(root, { alive: live, now: () => at });
		expect(view.builds?.map((b) => [b.build.feature, b.tail, b.costUsd])).toEqual([
			['1', ['from one'], 1.5],
			['3', ['from three'], 0.5]
		]);
		// the single-build fields follow the oldest, for an older reader
		expect(view.tail).toEqual(['from one']);
		expect(view.featureCostUsd).toBe(1.5);
	});

	it('reads the one build of an older file, which has no builds, as one entry', () => {
		log('old', [assistant({ type: 'text', text: 'from old' })]);
		writeFileSync(
			join(root, '.factory', 'status.json'),
			JSON.stringify({ pid: 42, recent: [], doing: building('old') })
		);
		const view = readFactory(root, { alive: live, now: () => at });
		expect(view.builds?.map((b) => b.tail)).toEqual([['from old']]);
	});

	it('carries the title of a pull or failed event to Completed', () => {
		const file = status();
		file.happened({ kind: 'pull', feature: '1', title: 'Dark mode', url: 'https://pr/1' });
		file.happened({ kind: 'failed', feature: '2', why: 'check red' });
		const { completed } = readFactory(root, { alive: live });
		expect(completed.map((c) => (c.event.kind === 'pull' ? c.event.title : 'none'))).toEqual([
			'Dark mode',
			'none'
		]);
	});

	it('gives the status as written and says stopped only when its pid is not alive', () => {
		status().doing(building(null));
		const running = readFactory(root, { alive: (pid) => pid === 42 });
		expect(running.status?.doing).toMatchObject({ kind: 'building', ticket: '2' });
		expect(running.stopped).toBe(false);
		// whatever `doing` says, a dead pid is a stopped run
		expect(readFactory(root, { alive: dead }).stopped).toBe(true);
	});

	it('asks the machine whether the pid is alive when not told', () => {
		// a pid that has just exited, so no machine has it alive
		const exited = spawnSync(process.execPath, ['-e', '']).pid;
		writeFileSync(
			join(root, '.factory', 'status.json'),
			JSON.stringify({ pid: exited, recent: [], doing: { kind: 'off' } })
		);
		expect(readFactory(root).stopped).toBe(true);
		writeFileSync(
			join(root, '.factory', 'status.json'),
			JSON.stringify({ pid: process.pid, recent: [], doing: { kind: 'off' } })
		);
		expect(readFactory(root).stopped).toBe(false);
	});

	it('reads an old status.json that lacks the newer fields', () => {
		writeFileSync(
			join(root, '.factory', 'status.json'),
			JSON.stringify({
				at: at.toISOString(),
				pid: 42,
				spentTodayUsd: 1,
				dailyUsd: 8,
				doing: building('s1'),
				recent: [{ seq: 1, at: at.toISOString(), kind: 'stale', commit: 'abc' }]
			})
		);
		const view = readFactory(root, { alive: live });
		expect(view.status?.queue).toBeUndefined();
		expect(view.status?.waitingOnYou).toBeUndefined();
		expect(view.completed).toEqual([]);
		expect(view.tail).toEqual([]);
	});

	it("reads an older file with only `doing` as one build, and follows the oldest build of a newer file's `builds`", () => {
		const old = {
			at: at.toISOString(),
			pid: 42,
			spentTodayUsd: 1,
			dailyUsd: 8,
			doing: building('s1'),
			recent: []
		};
		ledger('1', 1.5);
		ledger('7', 4);
		log('s1', [assistant({ type: 'text', text: 'from doing' })]);
		log('s7', [assistant({ type: 'text', text: 'from the newer build' })]);
		const path = join(root, '.factory', 'status.json');
		writeFileSync(path, JSON.stringify(old));
		let view = readFactory(root, { alive: live, now: () => at });
		expect(view.tail).toEqual(['from doing']);
		expect(view.featureCostUsd).toBe(1.5);
		// a newer file: `builds` is read, whatever `doing` says
		const other = { ...building('s7'), feature: '7' };
		writeFileSync(path, JSON.stringify({ ...old, doing: building(null), builds: [other] }));
		view = readFactory(root, { alive: live, now: () => at });
		expect(view.tail).toEqual(['from the newer build']);
		expect(view.featureCostUsd).toBe(4);
	});

	it('tails the session: assistant text, and each tool call by its command or file, without results', () => {
		status().doing(building('s1'));
		log('s1', [
			{ type: 'system', subtype: 'init' },
			assistant({ type: 'text', text: 'Reading the\nmarks module.' }),
			assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/w/src/marks.ts' } }),
			{
				type: 'user',
				message: { content: [{ type: 'tool_result', content: 'export const marks = 1' }] }
			},
			assistant(
				{ type: 'tool_use', name: 'Bash', input: { command: 'npm run check' } },
				{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }
			),
			{ type: 'result', result: 'done' }
		]);
		expect(readFactory(root, { alive: live }).tail).toEqual([
			'Reading the marks module.',
			'Read: /w/src/marks.ts',
			'Bash: npm run check',
			'TodoWrite'
		]);
	});

	it('keeps the last N readable lines, and skips a line that does not parse', () => {
		status().doing(building('s1'));
		log('s1', [
			assistant({ type: 'text', text: 'one' }),
			'{"type":"assistant","message":',
			assistant({ type: 'text', text: 'two' }),
			'not json at all',
			assistant({ type: 'text', text: 'three' }),
			'{"type":"assistant"}',
			assistant({ type: 'text', text: 'four' })
		]);
		expect(readFactory(root, { alive: live, tail: 3 }).tail).toEqual(['two', 'three', 'four']);
	});

	it('has no tail when the session has no log yet, or nothing is building', () => {
		status().doing(building('missing'));
		expect(readFactory(root, { alive: live }).tail).toEqual([]);
		status().doing({ kind: 'idle', nextPollAt: at.toISOString() });
		expect(readFactory(root, { alive: live }).tail).toEqual([]);
	});

	it('lists what completed, the pull and failed events, each with the cost of its own build', () => {
		ledger('1', 1.5);
		ledger('1', 0.5);
		ledger('2', 3);
		// a line written before ids were strings
		ledger(4, 0.25);
		const file = status();
		file.happened({ kind: 'built', feature: '1', ticket: '9' });
		file.happened({ kind: 'pull', feature: '1', url: 'https://pr/1' });
		file.happened({ kind: 'failed', feature: '2', why: 'check red' });
		file.happened({ kind: 'needs-info', feature: '3', ticket: null, why: 'unclear' });
		file.happened({ kind: 'pull', feature: '4', url: 'https://pr/4' });
		file.happened({ kind: 'pull', feature: '5', url: 'https://pr/5' });
		const { completed } = readFactory(root, { alive: live });
		expect(completed.map((c) => [c.event.kind, c.event.feature, c.costUsd])).toEqual([
			['pull', '1', 2],
			['failed', '2', 3],
			['pull', '4', 0.25],
			['pull', '5', 0]
		]);
	});
});

describe('the cost of each build', () => {
	const time = (m: number) => new Date(2026, 9, 30, 9, m);

	it('gives each Completed row only its own build, when a Feature is built again', () => {
		let now = time(0);
		const file = new StatusFile({
			path: join(root, '.factory', 'status.json'),
			spend: fileSpend(join(root, '.factory', 'runs.jsonl')),
			now: () => now,
			pid: 42,
			dailyUsd: 60
		});
		ledger('1', 1, time(5));
		now = time(10);
		file.happened({ kind: 'failed', feature: '1', why: 'check red' });
		ledger('1', 2, time(20));
		now = time(30);
		file.happened({ kind: 'pull', feature: '1', url: 'https://pr/1' });
		const { completed } = readFactory(root, { alive: live });
		expect(completed.map((c) => [c.event.kind, c.costUsd])).toEqual([
			['failed', 1],
			['pull', 2]
		]);
	});

	it('gives the current build only what it spent since it started', () => {
		ledger('1', 1, time(5));
		ledger('1', 2, time(20));
		status().doing({ ...building(null), startedAt: time(15).toISOString() });
		expect(readFactory(root, { alive: live }).featureCostUsd).toBe(2);
	});

	it('splits each build by stage and by model, over the same Sessions as its cost', () => {
		const runs = join(root, '.factory', 'runs.jsonl');
		const line = (step: 'build' | 'fix' | 'review', costUsd: number, when: Date) =>
			record(runs, {
				at: when.toISOString(),
				repo: 'o/r',
				feature: '1',
				ticket: step === 'review' ? null : '2',
				branch: 'b',
				step,
				session: step === 'review' ? 'r' : 's',
				costUsd,
				outcome: 'done',
				...(step === 'review'
					? {
							models: [
								{
									model: 'm',
									inputTokens: 1,
									outputTokens: 2,
									cacheReadTokens: 3,
									cacheWriteTokens: 4,
									costUsd
								}
							]
						}
					: {})
			});
		let now = time(0);
		const file = new StatusFile({
			path: join(root, '.factory', 'status.json'),
			spend: fileSpend(runs),
			now: () => now,
			pid: 42,
			dailyUsd: 60
		});
		line('build', 3, time(5));
		line('fix', 1, time(6));
		line('review', 0.5, time(7));
		now = time(10);
		file.happened({ kind: 'pull', feature: '1', url: 'https://pr/1' });
		line('build', 2, time(20));
		file.doing({ ...building(null), featureStartedAt: time(15).toISOString() });

		const view = readFactory(root, { alive: live });
		const cost = view.completed[0]?.cost;
		expect(cost?.stages).toEqual([
			{ stage: 'tickets', usd: 4, sessions: 2 },
			{ stage: 'review', usd: 0.5, sessions: 1 }
		]);
		expect(cost?.models.map((m) => [m.model, m.costUsd])).toEqual([['m', 0.5]]);
		expect(cost?.unrecorded).toEqual({ sessions: 2, usd: 4 });
		expect(view.featureCost?.stages).toEqual([{ stage: 'tickets', usd: 2, sessions: 1 }]);
		expect(view.featureCost?.usd).toBe(view.featureCostUsd);
	});

	it('counts the Pull-check fix rounds after a draft pull request with the build that opened it', () => {
		const runs = join(root, '.factory', 'runs.jsonl');
		const line = (step: 'build' | 'review' | 'pullChecks', outcome: string, when: Date) =>
			record(runs, {
				at: when.toISOString(),
				repo: 'o/r',
				feature: '1',
				ticket: step === 'build' ? '2' : null,
				branch: 'b',
				step,
				session: `s-${String(when.getTime())}`,
				costUsd: step === 'pullChecks' ? 0.75 : 1,
				outcome,
				...(outcome.endsWith('gave up') ? { failure: 'lasting' as const } : {})
			});
		let now = time(0);
		const file = new StatusFile({
			path: join(root, '.factory', 'status.json'),
			spend: fileSpend(runs),
			now: () => now,
			pid: 42,
			dailyUsd: 60
		});
		line('build', 'built', time(5));
		line('review', 'approve', time(6));
		now = time(10);
		file.happened({ kind: 'pull', feature: '1', url: 'https://pr/1' });
		// the Pull-check fix rounds run later, from the watch, and write no event of their own
		line('pullChecks', 'pull checks 1', time(15));
		line('pullChecks', 'pull checks 2 gave up', time(20));
		// the next build, on a request for changes, fails before it opens a pull request
		line('build', 'failed: red', time(30));
		now = time(35);
		file.happened({ kind: 'failed', feature: '1', why: 'check red' });

		const [pulled, failed] = readFactory(root, { alive: live }).completed;
		expect(pulled?.costUsd).toBe(3.5);
		expect(pulled?.cost?.stages.find((s) => s.stage === 'pullChecks')).toEqual({
			stage: 'pullChecks',
			usd: 1.5,
			sessions: 2
		});
		expect(pulled?.stages?.find((s) => s.stage === 'pullChecks')).toMatchObject({
			state: 'failed',
			sessions: 2,
			usd: 1.5
		});
		// and not with the build after it
		expect(failed?.costUsd).toBe(1);
		expect(failed?.cost?.stages.map((s) => s.stage)).toEqual(['tickets']);
	});

	it('gives each build its stages over the same Sessions, the one in flight its running stage', () => {
		const runs = join(root, '.factory', 'runs.jsonl');
		const line = (
			step: 'build' | 'fix' | 'review',
			session: string,
			outcome: string,
			when: Date,
			failure?: 'lasting'
		) =>
			record(runs, {
				at: when.toISOString(),
				repo: 'o/r',
				feature: '1',
				ticket: step === 'review' ? null : '2',
				branch: 'b',
				step,
				session,
				costUsd: 1,
				outcome,
				...(failure === undefined ? {} : { failure })
			});
		let now = time(0);
		const file = new StatusFile({
			path: join(root, '.factory', 'status.json'),
			spend: fileSpend(runs),
			now: () => now,
			pid: 42,
			dailyUsd: 60
		});
		line('build', 's', 'built', time(5));
		line('fix', 's', 'round 1 gave up', time(6), 'lasting');
		now = time(10);
		file.happened({ kind: 'failed', feature: '1', why: 'check red' });
		line('build', 't', 'built', time(20));
		line('review', 'r', 'approve', time(25));
		now = time(30);
		file.happened({ kind: 'pull', feature: '1', url: 'https://pr/1' });
		line('build', 'u', 'built', time(40));
		file.doing({
			...building(null),
			step: 'review',
			ticket: null,
			featureStartedAt: time(35).toISOString()
		});

		const view = readFactory(root, { alive: live });
		const states = (stages: readonly { stage: string; state: string }[] | undefined) =>
			stages?.map((s) => `${s.stage} ${s.state}`);
		// with no factory.json, a stage the failed build did not get to is not reached
		expect(states(view.completed[0]?.stages)).toEqual([
			'tickets failed',
			'steps notReached',
			'review notReached',
			'reviewRounds notReached',
			'pullChecks notReached',
			'feedback notReached'
		]);
		expect(states(view.completed[1]?.stages)?.slice(0, 3)).toEqual([
			'tickets passed',
			'steps notNeeded',
			'review passed'
		]);
		expect(view.featureStages?.find((s) => s.stage === 'review')).toMatchObject({
			state: 'running',
			sessions: 0
		});
		expect(view.featureStages?.[0]).toMatchObject({ stage: 'tickets', state: 'passed', usd: 1 });

		// factory.json that switches the Review off and has no Workflow: the failed build never needed them
		writeFileSync(
			join(root, 'factory.json'),
			JSON.stringify({
				tracker: { type: 'github', repo: 'o/app' },
				codeHost: { type: 'github', repo: 'o/app' },
				check: 'npm test',
				allowedCommands: ['npm test'],
				review: { enabled: false }
			})
		);
		expect(states(readFactory(root, { alive: live }).completed[0]?.stages)).toEqual([
			'tickets failed',
			'steps notNeeded',
			'review notNeeded',
			'reviewRounds notNeeded',
			'pullChecks notNeeded',
			'feedback notReached'
		]);

		// another Workflow has a Step: not reached, until the Logbook says the build ran on one with none
		writeFileSync(
			join(root, 'factory.json'),
			JSON.stringify({
				tracker: { type: 'github', repo: 'o/app' },
				codeHost: { type: 'github', repo: 'o/app' },
				check: 'npm test',
				allowedCommands: ['npm test'],
				workflows: {
					bug: { prompt: 'find the cause first' },
					ui: { steps: [{ name: 'polish', prompt: 'polish it', point: 'afterAllTickets' }] }
				}
			})
		);
		const steps = () =>
			readFactory(root, { alive: live }).completed[0]?.stages?.find((s) => s.stage === 'steps')
				?.state;
		expect(steps()).toBe('notReached');
		fileLogbook(root).write({
			kind: 'buildStarted',
			by: 'go',
			branch: 'b',
			workflow: 'bug',
			at: time(1).toISOString(),
			feature: '1'
		});
		expect(steps()).toBe('notNeeded');
	});

	it('has no split while nothing is building', () => {
		ledger('1', 1);
		expect(readFactory(root, { alive: live })).not.toHaveProperty('featureCost');
		expect(readFactory(root, { alive: live })).not.toHaveProperty('featureStages');
	});

	it("counts from the Feature's start, not the step's", () => {
		ledger('1', 1, time(5));
		ledger('1', 2, time(20));
		ledger('1', 4, time(40));
		status().doing({
			...building(null),
			featureStartedAt: time(15).toISOString(),
			startedAt: time(30).toISOString()
		});
		expect(readFactory(root, { alive: live }).featureCostUsd).toBe(6);
	});
});
