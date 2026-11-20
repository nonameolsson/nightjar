import { describe, expect, it } from 'vitest';
import { publishMark, publishMarkOf } from './publish.js';

describe('the publish mark in a pull request body', () => {
	it('gives back whether the Feature was complete and the last Review approved', () => {
		for (const complete of [true, false]) {
			for (const approved of [true, false]) {
				const body = `Nightjar built it.\n\n## Review\n\nApprove: fine.\n\n${publishMark({ complete, approved })}`;
				expect(publishMarkOf(body)).toEqual({ complete, approved });
			}
		}
	});

	it('is hidden: an HTML comment on a line of its own', () => {
		expect(publishMark({ complete: true, approved: true })).toMatch(/^<!-- [^\n]* -->$/);
	});

	it('gives nothing for a body written without it, as one by an earlier Nightjar or a person', () => {
		expect(publishMarkOf('Nightjar built all of #1 One.\n\n<!-- nightjar-feature: 1 -->')).toBe(
			null
		);
		expect(publishMarkOf('')).toBe(null);
	});

	it('still reads once later sections are added after it', () => {
		const body = `Built.\n\n${publishMark({ complete: true, approved: false })}\n\n## Pull checks\n\nRound 1 pushed.\n\n<!-- nightjar-pull-checks: handed to a person -->`;
		expect(publishMarkOf(body)).toEqual({ complete: true, approved: false });
	});
});
