import { describe, expect, it } from 'vitest';
import {
	featureStopStep,
	featureWaitingStep,
	reviewStep,
	stoppedStep,
	ticketAnswerStep,
	ticketHumanStep,
	ticketRetryStep
} from './next-step.js';
import { DEFAULT_SIGNAL_NAMES, type SignalNames } from './signals.js';

const names = DEFAULT_SIGNAL_NAMES;
const renamed: SignalNames = { ...names, go: 'run-it', ready: 'build-me', needsInfo: 'stuck' };

describe('next steps', () => {
	it('tells a person to answer, hand the Ticket back and give the Go again', () => {
		const got = ticketAnswerStep(names);
		expect(got).toMatch(/^\*\*Next step\*\*/);
		expect(got).toContain('1. Answer in a comment here.');
		expect(got).toContain('2. On this Ticket, remove `needs-info` and add `ready-for-agent`.');
		expect(got).toContain('3. On its Feature, add `factory-go`');
	});

	it('names the Signals as factory.json renames them', () => {
		const got = ticketAnswerStep(renamed);
		expect(got).toContain('remove `stuck` and add `build-me`');
		expect(got).toContain('add `run-it`');
		expect(got).not.toContain('factory-go');
	});

	it('tells a person to fix what a failed Ticket names, then hand it back', () => {
		const got = ticketRetryStep(names);
		expect(got).toContain('remove `needs-info` and add `ready-for-agent`');
		expect(got).toContain('add `factory-go`');
	});

	it('tells a person a Ticket after its question rounds is theirs to build or clear up', () => {
		const got = ticketHumanStep(names);
		expect(got).toContain('Build it yourself');
		expect(got).toContain('remove `ready-for-human` and add `ready-for-agent`');
	});

	it('tells a person to clear needs-info on a stopped Feature and give the Go again', () => {
		const got = featureStopStep(names);
		expect(got).toContain('On this Feature, remove `needs-info` and add `factory-go`');
	});

	it('sends a person from a Feature with waiting Tickets to those Tickets first', () => {
		const got = featureWaitingStep(names);
		expect(got).toContain('waiting Tickets');
		expect(got).toContain('`ready-for-agent`');
		expect(got).toContain('On this Feature, remove `needs-info` and add `factory-go`');
	});

	it('tells a person a stopped Feature goes on with the Go', () => {
		expect(stoppedStep(names)).toContain('add `factory-go`');
	});

	it('says an approved review needs no reply, and a changes review needs a fix or an accept', () => {
		expect(reviewStep('approve')).toContain('Nothing is waiting on you');
		expect(reviewStep('changes')).toContain('Fix the issues above');
	});
});
