import { describe, expect, it } from 'vitest';
import { buildStages, neverRun, runningStage, type StageLine } from './build-stages.js';
import type { Entry } from './spend.js';

// One ledger line of a build, as an older line has it: no models, no duration
const line = (
	step: Entry['step'],
	outcome: string,
	o: {
		readonly ticket?: string | null;
		readonly session?: string;
		readonly costUsd?: number;
		readonly failure?: Entry['failure'];
	} = {}
): StageLine => ({
	step,
	outcome,
	ticket: o.ticket === undefined ? (step === 'build' || step === 'fix' ? '2' : null) : o.ticket,
	session: o.session ?? `s-${step}`,
	costUsd: o.costUsd ?? 1,
	...(o.failure === undefined ? {} : { failure: o.failure })
});

// each stage's state, by name, in the bar's order
const states = (...args: Parameters<typeof buildStages>) =>
	buildStages(...args).map((s) => [s.stage, s.state]);

describe('buildStages', () => {
	it('gives a clean build passed where it ran and not needed elsewhere, in the bar order, with Sessions and cost', () => {
		const lines = [
			line('build', 'built', { ticket: '2', session: 'a', costUsd: 2 }),
			line('build', 'built', { ticket: '3', session: 'b', costUsd: 3 }),
			line('step', 'Lint: round 1', { ticket: null, session: 'c', costUsd: 0.5 }),
			line('review', 'approve', { session: 'r', costUsd: 0.25 })
		];
		const stages = buildStages(lines, { end: 'pull' });
		expect(stages).toEqual([
			{ stage: 'tickets', state: 'passed', sessions: 2, usd: 5 },
			{ stage: 'steps', state: 'passed', sessions: 1, usd: 0.5 },
			{ stage: 'review', state: 'passed', sessions: 1, usd: 0.25 },
			{ stage: 'reviewRounds', state: 'notNeeded', sessions: 0, usd: 0 },
			{ stage: 'pullChecks', state: 'notNeeded', sessions: 0, usd: 0 },
			{ stage: 'feedback', state: 'notNeeded', sessions: 0, usd: 0 }
		]);
	});

	it('marks a Ticket that needed a fix round as passed after a retry or a round', () => {
		const lines = [
			line('build', 'built', { session: 'a' }),
			line('fix', 'round 1', { session: 'a' })
		];
		expect(buildStages(lines, { end: 'pull' })[0]).toMatchObject({
			stage: 'tickets',
			state: 'retried',
			sessions: 2
		});
	});

	it('marks a Session tried again after a passing failure as passed after a retry', () => {
		const lines = [
			line('build', 'failed: overloaded', { session: 'a', failure: 'passing' }),
			line('build', 'built', { session: 'b' }),
			line('review', 'failed: overloaded', { session: 'r1', failure: 'passing' }),
			line('review', 'approve', { session: 'r2' })
		];
		expect(states(lines, { end: 'pull' }).slice(0, 3)).toEqual([
			['tickets', 'retried'],
			['steps', 'notNeeded'],
			['review', 'retried']
		]);
	});

	it('fails a stage whose last try failed for a passing reason, with nothing after it', () => {
		const lines = [line('build', 'failed: overloaded', { failure: 'passing' })];
		expect(buildStages(lines, { end: 'failed' })[0]?.state).toBe('failed');
	});

	it('fails a stage with a Session that failed, gave up, was blocked or asked questions, older lines too', () => {
		const failed = (l: StageLine) =>
			buildStages([l], { end: 'failed' }).find((s) => s.sessions > 0);
		expect(failed(line('build', 'failed: budget', { failure: 'budget' }))?.state).toBe('failed');
		// an older line names the failure only in its outcome
		expect(failed(line('build', 'failed: the check stayed red'))?.state).toBe('failed');
		expect(failed(line('build', 'questions, round 1'))?.state).toBe('failed');
		expect(failed(line('step', 'Lint: blocked'))?.state).toBe('failed');
		expect(failed(line('pullChecks', 'pull checks 1 gave up'))?.state).toBe('failed');
		expect(failed(line('pullChecks', 'pull checks 2 failed: red'))?.state).toBe('failed');
		expect(failed(line('reviewRound', 'stopped by a person'))?.state).toBe('failed');
	});

	it('leaves a stage after the failure not reached, and one the build went past not needed', () => {
		const lines = [
			line('build', 'built', { ticket: '2', session: 'a' }),
			line('fix', 'round 1 gave up', { ticket: '2', session: 'a', failure: 'lasting' })
		];
		expect(states(lines, { end: 'failed' })).toEqual([
			['tickets', 'failed'],
			['steps', 'notReached'],
			['review', 'notReached'],
			['reviewRounds', 'notReached'],
			['pullChecks', 'notReached'],
			['feedback', 'notReached']
		]);
		const reviewed = [
			line('build', 'built'),
			line('review', 'failed: red', { failure: 'lasting' })
		];
		expect(states(reviewed, { end: 'failed' })).toEqual([
			['tickets', 'passed'],
			// the build went past the Steps and the Feedback round without running them
			['steps', 'notNeeded'],
			['review', 'failed'],
			['reviewRounds', 'notReached'],
			['pullChecks', 'notReached'],
			['feedback', 'notNeeded']
		]);
	});

	it('says not needed for a stage the config never runs, even before the build gets to it', () => {
		const never = neverRun({ review: { enabled: false } });
		const lines = [line('build', 'failed: x', { failure: 'lasting' })];
		expect(states(lines, { end: 'failed', neverRun: never })).toEqual([
			['tickets', 'failed'],
			['steps', 'notNeeded'],
			['review', 'notNeeded'],
			['reviewRounds', 'notNeeded'],
			['pullChecks', 'notNeeded'],
			['feedback', 'notReached']
		]);
	});

	it('marks a Review that ran again after a Review round, and a second round, as passed after a round', () => {
		const lines = [
			line('build', 'built'),
			line('review', 'changes', { session: 'r1' }),
			line('reviewRound', 'fixed', { session: 'rr1' }),
			line('review', 'approve', { session: 'r2' })
		];
		expect(states(lines, { end: 'pull' }).slice(2, 4)).toEqual([
			['review', 'retried'],
			['reviewRounds', 'passed']
		]);
		const twice = [...lines, line('reviewRound', 'fixed', { session: 'rr2' })];
		expect(buildStages(twice, { end: 'pull' })[3]?.state).toBe('retried');
	});

	it('marks a Step that took a second round, and a second Pull-check fix, as passed after a round', () => {
		const lines = [
			line('build', 'built'),
			line('step', 'Polish: round 1', { ticket: null, session: 'p1' }),
			line('step', 'Polish: round 2', { ticket: null, session: 'p2' }),
			line('pullChecks', 'pull checks 2', { session: 'pc' })
		];
		const stages = buildStages(lines, { end: 'pull' });
		expect(stages.find((s) => s.stage === 'steps')?.state).toBe('retried');
		expect(stages.find((s) => s.stage === 'pullChecks')?.state).toBe('retried');
	});

	it('gives a Step fix round to the Steps, through the Session it resumes', () => {
		const lines = [
			line('build', 'built', { session: 'a' }),
			line('step', 'Lint: round 1', { ticket: null, session: 'l' }),
			line('fix', 'round 1', { ticket: null, session: 'l' })
		];
		expect(states(lines, { end: 'pull' }).slice(0, 2)).toEqual([
			['tickets', 'passed'],
			['steps', 'retried']
		]);
	});

	it('marks the stage running now, those it went past not needed and those ahead not reached, for a build in flight', () => {
		const lines = [line('build', 'built', { session: 'a' })];
		const stages = buildStages(lines, { end: 'building', running: 'review' });
		expect(stages.map((s) => [s.stage, s.state])).toEqual([
			['tickets', 'passed'],
			['steps', 'notNeeded'],
			['review', 'running'],
			['reviewRounds', 'notReached'],
			['pullChecks', 'notReached'],
			['feedback', 'notNeeded']
		]);
		// its Session has no line until it ends
		expect(stages[2]).toMatchObject({ sessions: 0, usd: 0 });
		// a Ticket being built while earlier Tickets' lines are in
		expect(buildStages(lines, { end: 'building', running: 'tickets' })[0]?.state).toBe('running');
	});

	it('has every stage not reached while the build sets up', () => {
		expect(
			buildStages([], { end: 'building', running: null }).every((s) => s.state === 'notReached')
		).toBe(true);
	});
});

describe('runningStage', () => {
	it('names the stage of the work status.json says is running, none while the build sets up', () => {
		expect(runningStage({ step: 'setup', ticket: null })).toBeNull();
		expect(runningStage({ step: 'build', ticket: '2' })).toBe('tickets');
		expect(runningStage({ step: 'fix', ticket: '2' })).toBe('tickets');
		expect(runningStage({ step: 'fix', ticket: null })).toBe('steps');
		expect(runningStage({ step: 'step', ticket: '2' })).toBe('steps');
		expect(runningStage({ step: 'review', ticket: null })).toBe('review');
		expect(runningStage({ step: 'reviewRound', ticket: null })).toBe('reviewRounds');
		expect(runningStage({ step: 'pullChecks', ticket: null })).toBe('pullChecks');
		expect(runningStage({ step: 'feedback', ticket: null })).toBe('feedback');
	});
});

describe('neverRun', () => {
	const steps = (n: number) => ({ steps: Array.from({ length: n }, () => ({})) });

	it('names Steps when no Workflow has one, and Pull checks unless they are on', () => {
		expect([...neverRun({})]).toEqual(['steps', 'pullChecks']);
		expect([...neverRun({ workflows: { bug: steps(0) } })]).toContain('steps');
		const both = { workflows: { bug: steps(0), ui: steps(1) }, pullChecks: { enabled: true } };
		expect([...neverRun(both)]).toEqual([]);
	});

	it('names the Review and its rounds when the Review is off, and its rounds when it has none', () => {
		const on = { workflows: { ui: steps(1) }, pullChecks: { enabled: true } };
		const off = neverRun({ ...on, review: { enabled: false } });
		expect([...off]).toEqual(['review', 'reviewRounds']);
		expect([...neverRun({ ...on, review: { fixRounds: 0 } })]).toEqual(['reviewRounds']);
		expect([...neverRun({ ...on, review: { enabled: true, fixRounds: 2 } })]).toEqual([]);
	});
});
