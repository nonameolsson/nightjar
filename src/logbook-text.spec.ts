// What a view says of each kind of Logbook decision.
import { describe, expect, it } from 'vitest';
import type { Decision, LogbookEntry } from './logbook.js';
import { decisionText } from './logbook-text.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';

const said = (decision: Decision) => {
	const entry: LogbookEntry = { at: '2026-10-30T09:00:00.000Z', feature: '1', ...decision };
	return decisionText(entry, DEFAULT_SIGNAL_NAMES);
};

describe('decisionText', () => {
	it('says each kind in one line, with what it holds folded beneath', () => {
		const cases: [Decision, string, string?][] = [
			[
				{ kind: 'buildStarted', by: 'go', branch: 'factory/1-a', workflow: 'default' },
				'Build started by the Go on factory/1-a, Workflow default'
			],
			[
				{
					kind: 'buildStarted',
					by: 'feedback',
					asked: 'r-1',
					branch: 'factory/1-a',
					workflow: null
				},
				'Build started by a request for changes (r-1) on factory/1-a'
			],
			[{ kind: 'setup', command: 'npm ci', ok: false }, 'Setup `npm ci` failed'],
			[{ kind: 'ticketStarted' }, 'Ticket started'],
			[{ kind: 'ticketBuilt', commit: 'abc1234' }, 'Ticket built in commit abc1234'],
			[
				{ kind: 'checkRed', report: 'lint: 1 problem', round: 2, rounds: 3 },
				'Check red, so fix round 2 of 3',
				'Gate report: lint: 1 problem'
			],
			[
				{ kind: 'thrownAway', branch: 'factory/1-a-attempt-1', why: 'still red' },
				'Thrown away onto factory/1-a-attempt-1: still red'
			],
			[
				{ kind: 'thrownAway', branch: null, why: 'no change' },
				'Thrown away, leaving nothing: no change'
			],
			[
				{
					kind: 'stepVerdict',
					workflow: 'default',
					step: 'docs',
					verdict: 'unmet',
					rounds: 2,
					left: ['README']
				},
				'Step docs of Workflow default: ran every round with its condition unmet after 2 rounds',
				'Left: README'
			],
			[
				{
					kind: 'review',
					verdict: 'changes',
					summary: 'Needs work.',
					issues: [
						{ file: 'a.ts', line: 1, problem: 'p' },
						{ file: 'b.ts', problem: 'q' }
					]
				},
				'Review asked for changes: Needs work.',
				'2 issues: a.ts:1 p\nb.ts q'
			],
			[{ kind: 'review', verdict: null, summary: null, issues: [] }, 'Review did not finish'],
			[{ kind: 'signal', signal: 'go', on: false }, 'Signal `factory-go` taken off'],
			[
				{ kind: 'pullOpened', url: 'https://example.test/pull/1', created: false },
				'Draft pull request updated: https://example.test/pull/1'
			],
			[{ kind: 'paused', why: 'the day is over' }, 'Paused: the day is over'],
			[
				{
					kind: 'feedbackRound',
					end: 'answered',
					commit: 'def5678',
					answered: ['c-1'],
					left: [{ id: 'c-2', why: 'out of scope' }]
				},
				'Feedback round answered in commit def5678: 1 answered, 1 left',
				'Feedback: answered c-1\nleft c-2: out of scope'
			],
			[
				{
					kind: 'pullFix',
					round: 1,
					rounds: 2,
					failing: [{ check: 'ci', job: 'test', step: 'npm test' }],
					end: 'gaveUp',
					why: 'over budget'
				},
				'Pull-check fix round 1 of 2 gave up: over budget',
				'1 failing Pull check: ci / test / npm test'
			],
			[
				{
					kind: 'pullFix',
					round: 1,
					rounds: 2,
					failing: [{ check: 'ci', job: 'test', step: 'npm test' }],
					end: 'diverged',
					why: 'a person pushed to the branch first; the fix is kept on nightjar/1-push-1'
				},
				'Pull-check fix round 1 of 2 set its fix aside: a person pushed to the branch first; the fix is kept on nightjar/1-push-1',
				'1 failing Pull check: ci / test / npm test'
			],
			[
				{ kind: 'madeBySource', source: 'sentry', key: 'ISSUE-1' },
				'Made by the Source sentry for ISSUE-1'
			],
			[
				{ kind: 'happenedAgain', source: 'sentry', times: 3 },
				'The Source sentry said it happened again (3 times)'
			],
			[
				{ kind: 'standingGo', source: 'sentry', owner: 'someone' },
				'The Source sentry gave the standing Go and assigned it to someone'
			],
			[
				{ kind: 'handed', to: 'human', why: 'needs a login' },
				'Handed to a person with `ready-for-human`: needs a login'
			]
		];
		for (const [decision, line, more] of cases) {
			const text = said(decision);
			expect(text.line).toBe(line);
			const folded = text.more === undefined ? undefined : `${text.more.label}: ${text.more.text}`;
			expect(folded).toBe(more);
		}
	});
});
