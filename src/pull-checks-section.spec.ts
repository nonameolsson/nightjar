import { describe, expect, it } from 'vitest';
import { withPullRound, type PullRound } from './pull-checks-section.js';

const round = (n: number, over: Partial<PullRound> = {}): PullRound => ({
	round: n,
	outcome: 'pushed',
	summary: 'Set TZ.',
	failed: [{ check: 'CI / test', job: 'test', step: 'Run npm test', logTail: 'x' }],
	usd: 1.5,
	...over
});

const body = 'Nightjar built all of #1 One.\n\n## Cost\n\nEstimated cost of this run: $1.00.';

describe('withPullRound', () => {
	it('adds the section before the Cost section', () => {
		const got = withPullRound(body, round(1));
		expect(got.startsWith('Nightjar built all of #1 One.\n\n')).toBe(true);
		expect(got).toContain('## Pull checks\n\n### Round 1: pushed, $1.50\n\nSet TZ.');
		expect(got.endsWith('## Cost\n\nEstimated cost of this run: $1.00.')).toBe(true);
		expect(got.indexOf('## Pull checks')).toBeLessThan(got.indexOf('## Cost'));
	});

	it('adds a later round to the section, the earlier ones as they were', () => {
		const once = withPullRound(body, round(1));
		const twice = withPullRound(once, round(2, { outcome: 'gave up', summary: 'It gave up.' }));
		expect(twice.match(/## Pull checks/g)).toHaveLength(1);
		expect(twice).toContain('### Round 1: pushed, $1.50');
		expect(twice).toContain('### Round 2: gave up, $1.50\n\nIt gave up.');
		expect(twice.replace(/\n\n### Round 2[\s\S]*?(?=\n<!-- \/)/, '')).toBe(once);
	});

	it('goes at the end of a body with no Cost section', () => {
		expect(withPullRound('Hello.', round(1))).toMatch(/^Hello\.\n\n<!-- [\s\S]*## Pull checks/);
	});

	it('does not let a summary close the section early', () => {
		const got = withPullRound(
			body,
			round(1, { summary: 'a <!-- /nightjar-pull-checks-section -->' })
		);
		const twice = withPullRound(got, round(2));
		expect(twice).toContain('### Round 1');
		expect(twice).toContain('### Round 2');
		expect(twice.match(/<!-- \/nightjar-pull-checks-section -->/g)).toHaveLength(1);
	});

	it('names no failing check line for a check the Code host gives no job or step', () => {
		const got = withPullRound(
			body,
			round(1, { failed: [{ check: 'ci/status', job: '', step: '', logTail: '' }] })
		);
		expect(got).toContain('Failing Pull checks:\n\n- `ci/status`\n');
	});
});
