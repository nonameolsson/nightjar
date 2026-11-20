import { describe, expect, it } from 'vitest';
import type { CodeHost, ConflictState } from './code-host.js';
import { conflicts, withConflicts, withoutConflicts } from './conflicts-section.js';

const PULL = { id: 7, url: 'https://code.example/pull/7' };
const BODY = 'Nightjar built all of #1 One.\n\n## Built\n\n- #2 Two';

// a Code host that answers each ask in turn, and the last one for every ask after
function asking(...answers: ConflictState[]) {
	const asked: number[] = [];
	const codeHost = {
		conflicts: () => {
			asked.push(asked.length);
			return Promise.resolve(answers[Math.min(asked.length, answers.length) - 1] ?? 'unknown');
		}
	} as unknown as CodeHost;
	return { codeHost, asked };
}

function sleeping() {
	const waits: number[] = [];
	return {
		waits,
		sleep: (ms: number) => {
			waits.push(ms);
			return Promise.resolve();
		}
	};
}

describe('the Conflicts section', () => {
	it('goes after the first paragraph and names the base branch', () => {
		const got = withConflicts(BODY, 'develop');
		expect(got).toContain('## Conflicts with develop');
		expect(got).toContain('merge or rebase `develop` before review');
		expect(got.indexOf('## Conflicts with develop')).toBeLessThan(got.indexOf('## Built'));
		expect(got.startsWith('Nightjar built all of #1 One.\n\n')).toBe(true);
	});

	it('is dropped, leaving the body as it was', () => {
		expect(withoutConflicts(withConflicts(BODY, 'main'))).toBe(BODY);
		expect(withoutConflicts(BODY)).toBe(BODY);
	});

	it('is never doubled', () => {
		const once = withConflicts(BODY, 'main');
		expect(withConflicts(once, 'main')).toBe(once);
	});
});

describe('asking whether a pull request conflicts', () => {
	it('answers at once when the Code host can say', async () => {
		const { codeHost, asked } = asking('yes');
		const { sleep, waits } = sleeping();
		expect(await conflicts(codeHost, PULL, sleep)).toBe(true);
		expect(asked).toHaveLength(1);
		expect(waits).toEqual([]);
		expect(await conflicts(asking('no').codeHost, PULL, sleep)).toBe(false);
	});

	it('asks again while the state is unknown, and takes the answer that comes', async () => {
		const { codeHost, asked } = asking('unknown', 'unknown', 'yes');
		const { sleep, waits } = sleeping();
		expect(await conflicts(codeHost, PULL, sleep)).toBe(true);
		expect(asked).toHaveLength(3);
		expect(waits).toEqual([1000, 1000]);
	});

	it('gives up after about ten seconds and says no conflict', async () => {
		const { codeHost, asked } = asking('unknown');
		const { sleep, waits } = sleeping();
		expect(await conflicts(codeHost, PULL, sleep)).toBe(false);
		expect(waits.reduce((a, b) => a + b, 0)).toBe(10_000);
		expect(asked).toHaveLength(11);
	});

	it('counts a Code host without the method as unknown, and does not wait', async () => {
		const { sleep, waits } = sleeping();
		expect(await conflicts({} as CodeHost, PULL, sleep)).toBe(false);
		expect(waits).toEqual([]);
	});
});
