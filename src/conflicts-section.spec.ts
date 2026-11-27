import { describe, expect, it } from 'vitest';
import type { CodeHost, ConflictState } from './code-host.js';
import {
	conflicts,
	hasConflictFixes,
	withConflictFix,
	withConflicts,
	withoutConflicts,
	type ConflictFix
} from './conflicts-section.js';

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

const fix = (round: number, over: Partial<ConflictFix> = {}): ConflictFix => ({
	round,
	outcome: 'fixed',
	summary: 'Kept both sides.',
	files: ['src/a.ts', 'src/b.ts'],
	usd: 1.5,
	...over
});

const NOTICE = 'merge or rebase `main` before review';

describe('the Conflicts section as a record of Conflict fixes', () => {
	it('adds a block after the first paragraph: the round, how it ended, what it cost, its summary and the files it resolved', () => {
		const got = withConflictFix(BODY, 'main', fix(1), true);
		expect(got).toContain(
			'## Conflicts with main\n\nThis pull request conflicts with `main`: merge or rebase `main` before review.\n\n' +
				'### Conflict fix 1: fixed, $1.50\n\nKept both sides.\n\nResolved files:\n\n- `src/a.ts`\n- `src/b.ts`\n'
		);
		expect(got.startsWith('Nightjar built all of #1 One.\n\n')).toBe(true);
		expect(got.indexOf('## Conflicts with main')).toBeLessThan(got.indexOf('## Built'));
		expect(got.endsWith('## Built\n\n- #2 Two')).toBe(true);
	});

	it('keeps the notice while the draft conflicts, and drops it, the blocks staying, once it does not', () => {
		const conflicting = withConflictFix(BODY, 'main', fix(1, { outcome: 'gave up' }), true);
		expect(conflicting).toContain(NOTICE);
		const resolved = withoutConflicts(conflicting);
		expect(resolved).not.toContain(NOTICE);
		expect(resolved).not.toContain('Conflicts with');
		expect(resolved).toContain('## Conflicts\n\n### Conflict fix 1: gave up, $1.50');
		// and the notice comes back, the blocks still there, when the host says it conflicts again
		expect(withConflicts(resolved, 'main')).toBe(conflicting);
	});

	it('drops the notice of a fix that succeeded, its block staying', () => {
		const got = withConflictFix(withConflicts(BODY, 'main'), 'main', fix(1), false);
		expect(got).not.toContain(NOTICE);
		expect(got).toContain('## Conflicts\n\n### Conflict fix 1: fixed, $1.50');
		expect(got.match(/## Conflicts/g)).toHaveLength(1);
	});

	it('adds a later fix after the earlier ones, which stay as they were', () => {
		const once = withConflictFix(BODY, 'main', fix(1, { outcome: 'gave up' }), true);
		const twice = withConflictFix(
			once,
			'main',
			fix(2, { summary: 'Took theirs.', usd: 0.25 }),
			false
		);
		const text = twice.slice(twice.indexOf('### Conflict fix 1'));
		expect(text).toMatch(
			/^### Conflict fix 1: gave up, \$1\.50[\s\S]*\n\n### Conflict fix 2: fixed, \$0\.25\n\nTook theirs\./
		);
		expect(twice.match(/^### Conflict fix /gm)).toHaveLength(2);
		expect(twice.match(/<!-- nightjar-conflicts-section -->/g)).toHaveLength(1);
		expect(twice.replace(/\n\n### Conflict fix 2[\s\S]*?(?=\n<!-- \/)/, '')).toBe(
			withoutConflicts(once)
		);
	});

	it('tells a fix that gave up by the files the merge stopped on, not as resolved', () => {
		const got = withConflictFix(
			BODY,
			'main',
			fix(1, {
				outcome: 'gave up',
				summary: 'It gave up: the Session is blocked.',
				files: ['x.ts']
			}),
			true
		);
		expect(got).toContain(
			'### Conflict fix 1: gave up, $1.50\n\nIt gave up: the Session is blocked.\n\nFiles the merge stopped on:\n\n- `x.ts`'
		);
		expect(got).not.toContain('Resolved files');
	});

	it('lists no files for a merge that had none to resolve', () => {
		const got = withConflictFix(BODY, 'main', fix(1, { files: [] }), false);
		expect(got).toContain('### Conflict fix 1: fixed, $1.50\n\nKept both sides.\n');
		expect(got).not.toMatch(/files/i);
	});

	it('does not let a summary close the section early', () => {
		const once = withConflictFix(
			BODY,
			'main',
			fix(1, { summary: 'a <!-- /nightjar-conflicts-section -->' }),
			true
		);
		const twice = withConflictFix(once, 'main', fix(2), true);
		expect(twice).toContain('### Conflict fix 1');
		expect(twice).toContain('### Conflict fix 2');
		expect(twice.match(/<!-- \/nightjar-conflicts-section -->/g)).toHaveLength(1);
	});

	it('keeps the hidden give-up mark, and whatever else ends the body, through every update', () => {
		const mark = '<!-- nightjar-conflicts: handed to a person -->';
		const signed = `${BODY}\n\n${mark}`;
		const added = withConflictFix(signed, 'main', fix(1, { outcome: 'gave up' }), true);
		expect(added.endsWith(`\n\n${mark}`)).toBe(true);
		const cleared = withoutConflicts(added);
		expect(cleared.endsWith(`\n\n${mark}`)).toBe(true);
		expect(withConflicts(cleared, 'main').endsWith(`\n\n${mark}`)).toBe(true);
		expect(withConflictFix(cleared, 'main', fix(2), false).endsWith(`\n\n${mark}`)).toBe(true);
	});

	it('works in a body of one paragraph, and drops cleanly from it', () => {
		const got = withConflictFix('Hello.', 'main', fix(1), true);
		expect(got.startsWith('Hello.\n\n<!-- nightjar-conflicts-section -->')).toBe(true);
		expect(withoutConflicts(withConflicts('Hello.', 'main'))).toBe('Hello.');
	});

	it('says whether the body holds a record of any Conflict fix', () => {
		expect(hasConflictFixes(BODY)).toBe(false);
		expect(hasConflictFixes(withConflicts(BODY, 'main'))).toBe(false);
		expect(hasConflictFixes(withConflictFix(BODY, 'main', fix(1), false))).toBe(true);
	});

	it('reads exactly as before for a body with no Conflict fix', () => {
		expect(withoutConflicts(BODY)).toBe(BODY);
		expect(withConflicts(BODY, 'main')).toBe(
			'Nightjar built all of #1 One.\n\n<!-- nightjar-conflicts-section -->\n## Conflicts with main\n\nThis pull request conflicts with `main`: merge or rebase `main` before review.\n<!-- /nightjar-conflicts-section -->\n\n## Built\n\n- #2 Two'
		);
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
