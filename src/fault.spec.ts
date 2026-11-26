import { describe, expect, it } from 'vitest';
import {
	BuildFault,
	faultAsk,
	passingFault,
	placeText,
	stackOf,
	withoutStack,
	type FaultPlace
} from './fault.js';
import { faultStep } from './next-step.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';
import { waitingCommentText } from './status-note.js';

const NEXT = faultStep(DEFAULT_SIGNAL_NAMES, { passing: false, pullFix: false });

describe('placeText', () => {
	const places: [FaultPlace, string][] = [
		[{ kind: 'setup' }, 'while setting up the Feature'],
		[{ kind: 'ticket', ticket: '3' }, 'while building Ticket #3'],
		[{ kind: 'step', workflow: 'w', ticket: '3' }, 'in a Step of the Workflow w, after Ticket #3'],
		[{ kind: 'step', workflow: null, ticket: null }, 'in a Step, after all Tickets'],
		[{ kind: 'review' }, 'in the Review'],
		[{ kind: 'reviewRound', round: 2 }, 'in Review round 2'],
		[{ kind: 'feedback' }, 'in a Feedback round'],
		[{ kind: 'pull' }, 'while pushing the branch and opening the draft pull request'],
		[{ kind: 'pullFix', round: 1 }, 'in Pull-check fix 1'],
		[{ kind: 'pullFix', round: null }, 'in a Pull-check fix']
	];

	it.each(places)('names %j as "%s"', (place, text) => {
		expect(placeText(place)).toBe(text);
	});
});

describe('passingFault', () => {
	it('takes the network, an overload and a 5xx as passing, and anything else as lasting', () => {
		expect(passingFault(new Error('read ECONNRESET'))).toBe(true);
		expect(passingFault(new Error('gh: Bad Gateway (HTTP 502)'))).toBe(true);
		expect(passingFault(new Error('the disk is full'))).toBe(false);
		expect(passingFault('fetch failed')).toBe(true);
	});

	it('reads a BuildFault by the fault inside it', () => {
		const run = { place: { kind: 'review' } as const, tickets: [], session: null, pull: null };
		expect(passingFault(new BuildFault(new Error('socket hang up'), run))).toBe(true);
	});
});

describe('BuildFault', () => {
	it("keeps the fault's message and stack, and where it happened", () => {
		const inner = new Error('the disk is full');
		const fault = new BuildFault(inner, {
			place: { kind: 'ticket', ticket: '2' },
			tickets: [],
			session: 'session-1',
			pull: null
		});
		expect(fault.message).toBe('the disk is full');
		expect(fault.place).toEqual({ kind: 'ticket', ticket: '2' });
		expect(fault.session).toBe('session-1');
		expect(stackOf(fault)).toBe(inner.stack);
	});
});

describe('withoutStack', () => {
	it('takes every line of a stack trace out', () => {
		const text = [
			'git push failed',
			'    at run (/x/git.js:10:5)',
			'    at async main (file:///x/main.js:3:1)',
			'    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
			'    at <anonymous>',
			'remote: rejected'
		].join('\n');
		expect(withoutStack(text)).toBe('git push failed\nremote: rejected');
	});

	it('keeps a line that only speaks of "at"', () => {
		expect(withoutStack('look at the log')).toBe('look at the log');
	});
});

describe('faultAsk', () => {
	const comment = (o: Partial<Parameters<typeof faultAsk>[0]>) =>
		waitingCommentText({
			...faultAsk({
				fault: new Error('the disk is full'),
				place: { kind: 'review' },
				pull: null,
				next: NEXT,
				...o
			}),
			logbook: { feature: '1', session: 'session-2' }
		});

	it('opens with the place and the cause, then says what to fix before the Go', () => {
		const text = comment({});
		expect(text).toMatch(
			/^\*\*Waiting on you\*\*: Nightjar stopped on a fault in the Review: the disk is full\.\n\nThis fault will probably happen again, so fix what it names before giving the Go again\.\n\n\*\*Next step\*\*\n\n1\. Fix what the fault above names first/
		);
		expect(text).toContain('Logbook: nightjar ui → #1 · session session-2');
	});

	it('says giving the Go again is likely to work for a passing fault', () => {
		expect(comment({ fault: new Error('read ETIMEDOUT') })).toContain(
			'so giving the Go again is likely to work.'
		);
	});

	it('speaks of another Pull-check fix, not the Go, after a fault in one', () => {
		const text = comment({ place: { kind: 'pullFix', round: 2 } });
		expect(text).toContain('in Pull-check fix 2: the disk is full.');
		expect(text).toContain('fix what it names before another Pull-check fix.');
	});

	it('names no place for a fault that escaped from outside a build', () => {
		expect(comment({ place: null })).toMatch(
			/^\*\*Waiting on you\*\*: Nightjar stopped on a fault: the disk is full\./
		);
	});

	it('quotes the rest of what the fault said only while no pull request holds it', () => {
		const fault = new Error('git push failed\nremote: rejected\n    at run (/x/git.js:10:5)');
		const quoted = comment({ fault });
		expect(quoted).toContain('```\nremote: rejected\n```');
		const pointed = comment({ fault, pull: 'https://example.test/pull/1' });
		expect(pointed).toContain('The pull request: https://example.test/pull/1');
		expect(pointed).not.toContain('remote: rejected');
		for (const text of [quoted, pointed]) expect(text).not.toContain('git.js');
	});

	it('cuts a long first line short in the headline', () => {
		const text = comment({ fault: new Error('x'.repeat(300)) });
		const headline = text.split('\n')[0] ?? '';
		expect(headline.length).toBeLessThan(300);
		expect(headline).toMatch(/x…\.$/);
	});
});
