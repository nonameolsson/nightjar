// A Ticket's body checked against docs/ticket-contract.md, with no Coding agent.
import { describe, expect, it } from 'vitest';
import { ticketFaults } from './ticket-contract.js';

const BODY = `**Model:** opus
**Effort:** high

Move \`escapeHtml\` into \`src/escape.ts\`.

### Acceptance criteria

- [ ] one module exports escapeHtml
- [x] the old copy is gone`;

describe('ticketFaults', () => {
	it('finds no fault in a body with criteria under their heading', () => {
		expect(ticketFaults(BODY)).toEqual([]);
		expect(ticketFaults('## Acceptance criteria\r\n\r\n* [ ] it works')).toEqual([]);
	});

	it('finds no fault in a body with no Model or Effort line', () => {
		expect(ticketFaults(BODY.replace('**Model:** opus\n**Effort:** high\n', ''))).toEqual([]);
	});

	it.each([
		['no criteria heading', BODY.replace('### Acceptance criteria', '### Done when')],
		[
			'a criteria heading with no checklist item',
			BODY.replace('- [ ] one module exports escapeHtml\n- [x] the old copy is gone', 'It works.')
		],
		['an empty checklist item', BODY.replace(/- \[[ x]\] .*/g, '- [ ]')],
		['a checklist under a later heading', BODY.replace('\n\n- [ ]', '\n\n## Notes\n\n- [ ]')],
		['a checklist only in a code block', '### Acceptance criteria\n\n```md\n- [ ] it works\n```'],
		['a checklist above the heading', '- [ ] it works\n\n### Acceptance criteria\n\nSoon.'],
		['an empty body', '']
	])('finds a fault that names the heading in a body with %s', (_what, body) => {
		const faults = ticketFaults(body);
		expect(faults).toHaveLength(1);
		expect(faults[0]).toContain('"Acceptance criteria" heading');
	});

	it('keeps a checklist under a deeper heading inside the criteria', () => {
		expect(
			ticketFaults(BODY.replace('\n\n- [ ] one', '\n\n#### The module\n\n- [ ] one'))
		).toEqual([]);
	});

	it.each([
		['Model', BODY.replace('**Model:** opus', '**Model:**')],
		['Effort', BODY.replace('**Effort:** high', 'Effort:   ')]
	])('finds a fault that names an empty %s line', (name, body) => {
		expect(ticketFaults(body)).toEqual([
			`Its **${name}:** line has no value; give it one or leave the line out.`
		]);
	});

	it('names every fault at once', () => {
		const faults = ticketFaults('**Model:**\n**Effort:**\n\nNo criteria.');
		expect(faults).toHaveLength(3);
		expect(faults.join('\n')).toMatch(/Acceptance criteria[\s\S]*Model[\s\S]*Effort/);
	});
});
