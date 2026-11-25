import { describe, expect, it } from 'vitest';
import { baseLine, baseOf, botPullMarker, botPullOf } from './base-line.js';

describe('the **Base:** line', () => {
	it('reads back the branch it writes', () => {
		const body = `A Feature.\n\n${baseLine('dependabot/npm_and_yarn/left-pad-1.1.0')}\n`;
		expect(baseOf(body)).toEqual({ branch: 'dependabot/npm_and_yarn/left-pad-1.1.0' });
	});

	it('takes the line with or without the bold', () => {
		expect(baseOf('Base: renovate/@types-node-20.x')).toEqual({
			branch: 'renovate/@types-node-20.x'
		});
	});

	it('is null when the body has no such line', () => {
		expect(baseOf('A Feature with no base.\n\nBased on a talk.')).toBeNull();
	});

	it('refuses a branch git would read as something else', () => {
		for (const bad of ['-x', 'a..b', 'a@{1}', 'a b', 'a/', 'a.lock', 'a~1', 'a:b']) {
			expect(baseOf(`**Base:** ${bad}`), bad).toHaveProperty('fault');
		}
	});
});

describe('the bot pull request marker', () => {
	it('reads back the pull request it names', () => {
		const pull = { id: 42, url: 'https://code.example/o/app/pull/42' };
		expect(botPullOf(`Body.\n${botPullMarker(pull)}\n`)).toEqual(pull);
	});

	it('is null when the body has none', () => {
		expect(botPullOf('Body.')).toBeNull();
	});
});
