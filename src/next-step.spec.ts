import { describe, expect, it } from 'vitest';
import * as next from './next-step.js';
import { DEFAULT_SIGNAL_NAMES, type SignalNames } from './signals.js';

// each Next step as the Tracker comment lays it out
const text = next.nextStepText;
const ticketStep = (n: SignalNames, kind: next.TicketHandBack) => text(next.ticketStep(n, kind));
const featureStopStep = (n: SignalNames) => text(next.featureStopStep(n));
const featureAfterRunStep = (n: SignalNames, why: { waiting: boolean; red: boolean }) =>
	text(next.featureAfterRunStep(n, why));
const stoppedStep = (n: SignalNames) => text(next.stoppedStep(n));
const pullChecksStep = (n: SignalNames) => text(next.pullChecksStep(n));
const pushRejectedStep = (n: SignalNames, side: string) => text(next.pushRejectedStep(n, side));

const names = DEFAULT_SIGNAL_NAMES;
const renamed: SignalNames = { ...names, go: 'run-it', ready: 'build-me', needsInfo: 'stuck' };

describe('next steps', () => {
	it('tells a person to answer, hand the Ticket back and give the Go again', () => {
		const got = ticketStep(names, 'answer');
		expect(got).toMatch(/^\*\*Next step\*\*/);
		expect(got).toContain('1. Answer the questions above in a comment here.');
		expect(got).toContain(
			'2. Then hand it back: on this Ticket, remove `needs-info` and add `ready-for-agent`; then on its Feature, remove `needs-info` and add `factory-go`'
		);
	});

	it('names the Signals as factory.json renames them', () => {
		const got = ticketStep(renamed, 'answer');
		expect(got).toContain('remove `stuck` and add `build-me`');
		expect(got).toContain('remove `stuck` and add `run-it`');
		expect(got).not.toContain('factory-go');
	});

	it('tells a person to answer or clear up the feedback of a thrown-away Feedback round, then give the Go again', () => {
		const got = text(next.feedbackStep(renamed));
		expect(got).toContain('1. Read why above: answer the feedback yourself on the pull request');
		expect(got).toContain('2. Then hand it back: on this Feature, remove `stuck` and add `run-it`');
		expect(got).toContain('Nightjar goes on from the branch, and answers the feedback');
	});

	it('tells a person to fix the issues a Review left open, or hand the Feature back with the Go', () => {
		const got = text(next.reviewStep(renamed));
		expect(got).toContain('1. Read the issues above');
		expect(got).toContain('remove `ready-for-human` and add `run-it` on this Feature');
		expect(got).toContain('Review rounds again');
	});

	it('tells a person to fix what a failed Ticket names, then hand it back', () => {
		const got = ticketStep(names, 'retry');
		expect(got).toContain('Read the reason above');
		expect(got).toContain('remove `needs-info` and add `ready-for-agent`');
		expect(got).toContain('on its Feature, remove `needs-info` and add `factory-go`');
	});

	it('tells a person a Ticket after its question rounds is theirs to build or clear up', () => {
		const got = ticketStep(names, 'human');
		expect(got).toContain('Build it yourself');
		expect(got).toContain('remove `ready-for-human` and add `ready-for-agent`');
	});

	it('tells a person to clear needs-info on a stopped Feature and give the Go again', () => {
		const got = featureStopStep(names);
		expect(got).toContain('on this Feature, remove `needs-info` and add `factory-go`');
	});

	it('sends a person from a Feature with waiting Tickets to those Tickets first', () => {
		const got = featureAfterRunStep(names, { waiting: true, red: false });
		expect(got).toContain('waiting Tickets');
		expect(got).not.toContain('failing check');
		expect(got).toContain('on this Feature, remove `needs-info` and add `factory-go`');
	});

	it('sends a person from a red check to the branch, naming no waiting Ticket', () => {
		const got = featureAfterRunStep(names, { waiting: false, red: true });
		expect(got).toContain('Fix the failing check on the branch');
		expect(got).not.toContain('waiting Tickets');
		expect(got).toContain('on this Feature, remove `needs-info` and add `factory-go`');
	});

	it('asks for both when a check is red and Tickets wait', () => {
		const got = featureAfterRunStep(names, { waiting: true, red: true });
		expect(got).toContain('Fix the failing check on the branch');
		expect(got).toContain('waiting Tickets');
	});

	it('tells a person a Feature with nothing waiting and nothing red needs a Ticket or a close', () => {
		const got = featureAfterRunStep(names, { waiting: false, red: false });
		expect(got).toContain('Add a Ticket');
		expect(got).not.toContain('waiting Tickets');
	});

	it('tells a person a stopped Feature goes on with the Go', () => {
		expect(stoppedStep(names)).toContain('add `factory-go`');
	});

	describe('the order of every variant that hands back to Nightjar', () => {
		const variants: [string, next.NextStep, string][] = [
			['answer', next.ticketStep(names, 'answer'), 'Answer the questions above'],
			['retry', next.ticketStep(names, 'retry'), 'Read the reason above'],
			['human', next.ticketStep(names, 'human'), 'Build it yourself'],
			['a Feature stop', next.featureStopStep(names), 'Fix the cause named above'],
			[
				'a Feature with waiting Tickets',
				next.featureAfterRunStep(names, { waiting: true, red: false }),
				'Deal with the waiting Tickets'
			],
			[
				'a Feature with a red check',
				next.featureAfterRunStep(names, { waiting: false, red: true }),
				'Fix the failing check'
			],
			['Pull checks', next.pullChecksStep(names), 'Read the failing Pull checks above'],
			['Review left open', next.reviewStep(names), 'Read the issues above'],
			['a thrown-away Feedback round', next.feedbackStep(names), 'Read why above'],
			['the Feedback limit', next.feedbackLimitStep(names), 'Answer the requests for changes'],
			['a rejected push', next.pushRejectedStep(names, 'side'), 'Look at `side`'],
			['stopped by a person', next.stoppedStep(names), 'Settle whatever made you stop'],
			[
				'a lasting fault',
				next.faultStep(names, { passing: false, pullFix: false }),
				'Fix what the fault above names first'
			],
			[
				'a passing fault',
				next.faultStep(names, { passing: true, pullFix: false }),
				'Nothing to fix first'
			],
			[
				'a fault in a Pull-check fix',
				next.faultStep(names, { passing: false, pullFix: true }),
				'Fix what the fault above names first'
			]
		];

		it.each(variants)('%s: task first, hand-back last', (_name, step, task) => {
			expect(step.length).toBeGreaterThanOrEqual(2);
			expect(step[0]).toContain(task);
			expect(step.at(-1)).toMatch(new RegExp(`^${next.HAND_BACK}`));
			// the Signal changes sit in the last step alone
			for (const line of step.slice(0, -1)) expect(line).not.toContain(`add \`${names.go}\``);
		});

		it('takes the Signal names in the last step from factory.json', () => {
			const last = next.ticketStep(renamed, 'answer').at(-1) ?? '';
			expect(last).toContain('remove `stuck` and add `build-me`');
			expect(last).toContain('add `run-it`');
			expect(next.stoppedStep(renamed).at(-1)).toContain('add `run-it`');
		});
	});

	it('gives the Go back after a fault in a build, and only takes needs-info off after one in a Pull-check fix', () => {
		const build = next.faultStep(renamed, { passing: true, pullFix: false }).at(-1) ?? '';
		expect(build).toContain('remove `stuck` and add `run-it`');
		const pullFix = next.faultStep(renamed, { passing: true, pullFix: true }).at(-1) ?? '';
		expect(pullFix).toContain('remove `stuck`');
		expect(pullFix).not.toContain('run-it');
		expect(pullFix).toContain('Nightjar tries a Pull-check fix again');
	});

	it('only takes needs-info off after a fault in a Conflict fix, which no Go starts either', () => {
		const step = next.faultStep(renamed, { passing: true, pullFix: false, conflictFix: true });
		const back = step.at(-1) ?? '';
		expect(back).toMatch(new RegExp(`^${next.HAND_BACK}`));
		expect(back).toContain('remove `stuck`');
		expect(back).not.toContain('run-it');
		expect(back).toContain('Nightjar tries a Conflict fix again');
	});

	it('tells a person a pause asks nothing of them, and when Nightjar goes on', () => {
		expect(next.pausedStep(true)).toEqual([
			'Nothing to do: the Go stays on this Feature, and Nightjar tries it again then, going on from the branch.'
		]);
		expect(next.pausedStep(false)[0]).toContain('the next time it runs');
	});

	it('hands a person the red Pull checks, and says the Go builds the branch with its fix rounds still counted', () => {
		const got = pullChecksStep(renamed);
		expect(got).toMatch(/^\*\*Next step\*\*/);
		expect(got).toContain('1. Read the failing Pull checks above');
		expect(got).toContain('2. Then hand it back: to have Nightjar build the Feature');
		expect(got).toContain('remove `ready-for-human` and add `run-it` on this Feature');
		expect(got).toContain('still count');
	});

	it('points a person at the side branch, and says the Go builds on top of their commits', () => {
		const got = pushRejectedStep(renamed, 'factory/4-x-attempt-push');
		expect(got).toMatch(/^\*\*Next step\*\*/);
		expect(got).toContain('1. Look at `factory/4-x-attempt-push`');
		expect(got).toContain('remove `ready-for-human` and add `run-it` on this Feature');
		expect(got).not.toContain('factory-go');
	});
});
