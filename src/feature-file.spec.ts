// A Feature file (docs/ticket-contract.md) read into the Feature and Tickets `nightjar create` makes.
import { describe, expect, it } from 'vitest';
import { ticketLine } from './build.js';
import { FeatureFileError, readFeatureFile } from './feature-file.js';

const FILE = `# Share one HTML escape

Two renderers escape HTML their own way.

## Solution

One escape, used by both.

## Ticket 1: Move the escape into one module

**Model:** opus
**Effort:** high

Move \`escapeHtml\` into \`src/escape.ts\`.

### Acceptance criteria

- [ ] one module exports escapeHtml

## Ticket 2: Use it in the comment renderer

**Blocked by:** 1

The comment renderer calls the shared escape.

### Acceptance criteria

- [ ] comments escape through src/escape.ts
- [ ] a comment with <b> shows it as text
`;

describe('readFeatureFile', () => {
	it('reads the Feature, and each Ticket with its body, its lines and what blocks it', () => {
		const plan = readFeatureFile(FILE);
		expect(plan.feature).toEqual({
			title: 'Share one HTML escape',
			body: 'Two renderers escape HTML their own way.\n\n## Solution\n\nOne escape, used by both.'
		});
		expect(plan.tickets.map((t) => [t.number, t.title, t.blockedBy])).toEqual([
			[1, 'Move the escape into one module', []],
			[2, 'Use it in the comment renderer', [1]]
		]);
		const [first, second] = plan.tickets;
		expect(first?.body).toBe(
			'**Model:** opus\n**Effort:** high\n\nMove `escapeHtml` into `src/escape.ts`.\n\n### Acceptance criteria\n\n- [ ] one module exports escapeHtml'
		);
		// the build reads these lines back from the body the Tracker holds
		expect([
			ticketLine(first?.body ?? '', 'Model'),
			ticketLine(first?.body ?? '', 'Effort')
		]).toEqual(['opus', 'high']);
		// the blocking link is made on the Tracker, so the line leaves the body
		expect(second?.body).toBe(
			'The comment renderer calls the shared escape.\n\n### Acceptance criteria\n\n- [ ] comments escape through src/escape.ts\n- [ ] a comment with <b> shows it as text'
		);
		expect(ticketLine(second?.body ?? '', 'Model')).toBeUndefined();
	});

	it('leaves a Ticket heading inside a code block in the body', () => {
		const plan = readFeatureFile(
			FILE.replace(
				'One escape, used by both.',
				'One escape, used by both.\n\n```md\n## Ticket 9: not a Ticket\n```'
			)
		);
		expect(plan.feature.body).toContain('```md\n## Ticket 9: not a Ticket\n```');
		expect(plan.tickets).toHaveLength(2);
	});

	it.each([
		[
			'no Feature title',
			FILE.replace('# Share one HTML escape', 'Share one HTML escape'),
			'line 1: '
		],
		['no Ticket', FILE.slice(0, FILE.indexOf('## Ticket 1')), 'no Ticket'],
		['a Ticket out of number', FILE.replace('## Ticket 2:', '## Ticket 3:'), 'Ticket 3'],
		[
			'a blocker below its Ticket',
			FILE.replace('**Model:** opus', '**Blocked by:** 2'),
			'Ticket 1'
		],
		[
			'a blocker that is no number',
			FILE.replace('**Blocked by:** 1', '**Blocked by:** #1'),
			'Ticket 2'
		],
		['a Ticket with no title', FILE.replace(': Use it in the comment renderer', ':'), 'line '],
		[
			'a Ticket with no acceptance criteria',
			FILE.replace('- [ ] one module exports escapeHtml', 'One module exports it.'),
			'Ticket 1 has no acceptance criteria'
		],
		['an empty Model line', FILE.replace('**Model:** opus', '**Model:**'), 'Ticket 1']
	])('refuses a file with %s, saying where', (_what, text, said) => {
		expect(() => readFeatureFile(text)).toThrow(FeatureFileError);
		expect(() => readFeatureFile(text)).toThrow(said);
	});

	it('names every fault at once', () => {
		const text = FILE.replace('## Ticket 2:', '## Ticket 3:').replace(
			'- [ ] one module exports escapeHtml',
			'nothing'
		);
		expect(() => readFeatureFile(text)).toThrow(
			/Ticket 1 has no acceptance criteria[\s\S]*Ticket 3/
		);
	});
});
