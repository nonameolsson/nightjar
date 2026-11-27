import { describe, expect, it } from 'vitest';
import { recap } from './recap.js';

const bold = (words: string) => `**${words}**`;

describe('recap', () => {
	it('says how to go on, in order, with each word bold where it is explained', () => {
		const lines = recap({ go: 'factory-go', bold }).split('\n');
		expect(lines).toEqual([
			'From here on:',
			'  1. Commit factory.json and .gitignore, so that your team gets the setup.',
			'  2. Write Features with `nightjar create`, with `/nightjar:feature` in Claude Code, or by hand.',
			'     Nightjar builds a **Feature** only when it is assigned to you and carries the **Go**. To give the Go, add `factory-go` to the Feature.',
			'     A **Ticket** is one buildable child of a Feature, built as one commit. Each Feature ends as one **draft pull request**, for you to review.',
			'  3. `nightjar --watch` builds Features as they come.',
			'  4. `nightjar ui` shows what Nightjar is doing.',
			'  5. `nightjar doctor` is for when something is wrong.'
		]);
	});

	it('opens with the link of the draft pull request when there is one', () => {
		const url = 'https://github.com/o/app/pull/9';
		const [first, second] = recap({ go: 'factory-go', bold, pullRequest: url }).split('\n');
		expect(first).toBe(`Your draft pull request: ${url}`);
		expect(second).toBe('From here on:');
	});
});
