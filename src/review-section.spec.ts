import { describe, expect, it } from 'vitest';
import type { Review } from './prompt.js';
import { reviewSection, type ReviewSession } from './review-section.js';

const ISSUE = { file: 'src/marks.ts', line: 3, problem: 'It escapes twice.' };
const changes: Review = { verdict: 'changes', summary: 'One bug.', issues: [ISSUE] };
const approve: Review = { verdict: 'approve', summary: 'Good.', issues: [] };
const review = (r: Review | null): ReviewSession => ({ kind: 'review', review: r });
const fixed: ReviewSession = {
	kind: 'round',
	round: 1,
	outcome: 'fixed',
	text: 'Escaped once.',
	usd: 2.5
};

describe('the Review section of a pull request', () => {
	it('lists each Review and Review round in order, each round with its cost', () => {
		expect(reviewSection([review(changes), fixed, review(approve)])).toBe(
			[
				'## Review',
				'### Review 1: Changes asked\n\nOne bug.',
				'### Review round 1: fixed, $2.50\n\nEscaped once.',
				'### Review 2: Approve\n\nGood.'
			].join('\n\n')
		);
	});

	it('lists what the last Review still asks for as open', () => {
		const section = reviewSection([review(changes)]);
		expect(section).toContain('### Still open\n\n- `src/marks.ts:3`: It escapes twice.');
	});

	it('lists nothing as open when a round fixed the issues and no Review read the result', () => {
		expect(reviewSection([review(changes), fixed])).not.toContain('Still open');
	});

	it('keeps the issues of the Review before a round that was thrown away open', () => {
		const thrown: ReviewSession = {
			kind: 'round',
			round: 1,
			outcome: 'thrown away',
			text: 'It reports itself blocked.',
			usd: 1
		};
		const section = reviewSection([review(changes), thrown]);
		expect(section).toContain(
			'### Review round 1: thrown away, $1.00\n\nIt reports itself blocked.'
		);
		expect(section).toContain('### Still open\n\n- `src/marks.ts:3`: It escapes twice.');
	});

	it('says a Review that did not finish did not, and leaves nothing open after it', () => {
		const section = reviewSection([review(changes), fixed, review(null)]);
		expect(section).toContain('### Review 2: did not finish');
		expect(section).not.toContain('Still open');
	});

	it('ends with the issues declined, each with its reason, after those still open', () => {
		const declined = [{ file: 'README.md', problem: 'Not described.', reason: 'It is internal.' }];
		const section = reviewSection([review(changes)], declined);
		expect(
			section.endsWith(
				'### Issues declined\n\n- `README.md`: Not described.\n  Reason: It is internal.'
			)
		).toBe(true);
		expect(section.indexOf('### Still open')).toBeLessThan(section.indexOf('### Issues declined'));
	});

	it('lists no declined issues when there are none', () => {
		expect(reviewSection([review(approve)])).not.toContain('Issues declined');
	});
});
