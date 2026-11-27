import { describe, expect, it } from 'vitest';
import { firstFeature, sentenceProblem } from './first-feature.js';
import { ticketFaults } from './ticket-contract.js';

describe('firstFeature', () => {
	it('makes one Ticket that holds to the contract, with no Model or Effort line', () => {
		const { feature, tickets } = firstFeature('Say hello');
		expect(feature).toEqual({ title: 'Say hello', body: 'Say hello' });
		expect(tickets).toEqual([
			{
				number: 1,
				title: 'Say hello',
				body: 'Say hello\n\n## Acceptance criteria\n\n- [ ] Say hello\n- [ ] the check passes',
				blockedBy: []
			}
		]);
		expect(ticketFaults(tickets[0]?.body ?? '')).toEqual([]);
	});
});

describe('sentenceProblem', () => {
	it.each([
		'Say hello',
		'Explain the Model: it is a table',
		'#1 is broken, fix it',
		'a'.repeat(255)
	])('takes %s', (sentence) => {
		expect(sentenceProblem(sentence)).toBeNull();
	});

	it.each([
		'',
		'  ',
		'a'.repeat(256),
		'```',
		'~~~ sh',
		'Model: opus',
		'**Effort:** high',
		'Model:',
		'Workflow: design-review',
		'Base: main'
	])('refuses "%s"', (sentence) => {
		expect(sentenceProblem(sentence)).not.toBeNull();
	});
});
