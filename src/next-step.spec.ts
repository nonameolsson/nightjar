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

const names = DEFAULT_SIGNAL_NAMES;
const renamed: SignalNames = { ...names, go: 'run-it', ready: 'build-me', needsInfo: 'stuck' };

describe('next steps', () => {
	it('tells a person to answer, hand the Ticket back and give the Go again', () => {
		const got = ticketStep(names, 'answer');
		expect(got).toMatch(/^\*\*Next step\*\*/);
		expect(got).toContain('1. Answer in a comment here.');
		expect(got).toContain('2. On this Ticket, remove `needs-info` and add `ready-for-agent`.');
		expect(got).toContain('3. On its Feature, remove `needs-info` and add `factory-go`');
	});

	it('names the Signals as factory.json renames them', () => {
		const got = ticketStep(renamed, 'answer');
		expect(got).toContain('remove `stuck` and add `build-me`');
		expect(got).toContain('remove `stuck` and add `run-it`');
		expect(got).not.toContain('factory-go');
	});

	it('tells a person to fix what a failed Ticket names, then hand it back', () => {
		const got = ticketStep(names, 'retry');
		expect(got).toContain('Read the reason above');
		expect(got).toContain('remove `needs-info` and add `ready-for-agent`');
		expect(got).toContain('On its Feature, remove `needs-info` and add `factory-go`');
	});

	it('tells a person a Ticket after its question rounds is theirs to build or clear up', () => {
		const got = ticketStep(names, 'human');
		expect(got).toContain('Build it yourself');
		expect(got).toContain('remove `ready-for-human` and add `ready-for-agent`');
	});

	it('tells a person to clear needs-info on a stopped Feature and give the Go again', () => {
		const got = featureStopStep(names);
		expect(got).toContain('On this Feature, remove `needs-info` and add `factory-go`');
	});

	it('sends a person from a Feature with waiting Tickets to those Tickets first', () => {
		const got = featureAfterRunStep(names, { waiting: true, red: false });
		expect(got).toContain('waiting Tickets');
		expect(got).not.toContain('failing check');
		expect(got).toContain('On this Feature, remove `needs-info` and add `factory-go`');
	});

	it('sends a person from a red check to the branch, naming no waiting Ticket', () => {
		const got = featureAfterRunStep(names, { waiting: false, red: true });
		expect(got).toContain('Fix the failing check on the branch');
		expect(got).not.toContain('waiting Tickets');
		expect(got).toContain('On this Feature, remove `needs-info` and add `factory-go`');
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

	it('hands a person the red Pull checks, and says the Go builds the branch with its fix rounds still counted', () => {
		const got = pullChecksStep(renamed);
		expect(got).toMatch(/^\*\*Next step\*\*/);
		expect(got).toContain('1. Read the failing Pull checks above');
		expect(got).toContain('2. To have Nightjar build the Feature on its branch again');
		expect(got).toContain('remove `ready-for-human` and add `run-it` on this Feature');
		expect(got).toContain('still count');
	});
});
