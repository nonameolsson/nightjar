import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { clackPrompter } from './prompter.js';

vi.mock('@clack/prompts', () => ({
	isCancel: (v: unknown) => typeof v === 'symbol',
	text: vi.fn(),
	select: vi.fn(),
	multiselect: vi.fn(),
	confirm: vi.fn(),
	log: { info: vi.fn() }
}));

// what clack gives back when the person presses Ctrl-C
const cancel = Symbol('clack:cancel') as never;

describe('clackPrompter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('trims a typed answer, and gives null on cancel', async () => {
		vi.mocked(clack.text).mockResolvedValueOnce('  make check  ').mockResolvedValueOnce(cancel);
		const p = clackPrompter();
		expect(await p.text('Check', undefined, () => null)).toBe('make check');
		expect(await p.text('Check', undefined, () => null)).toBeNull();
	});

	it('checks an empty answer as its fallback, and passes a refusal to clack', async () => {
		vi.mocked(clack.text).mockResolvedValueOnce('');
		const seen: string[] = [];
		await clackPrompter().text('Repo', 'o/app', (t) => {
			seen.push(t);
			return t === 'nope' ? 'must be owner/name' : null;
		});
		const asked = vi.mocked(clack.text).mock.calls[0]?.[0];
		expect(asked?.defaultValue).toBe('o/app');
		const validate = asked?.validate;
		if (typeof validate !== 'function') throw new Error('no validate given to clack');
		expect(validate('  ')).toBeUndefined();
		expect(validate('nope')).toBe('must be owner/name');
		expect(seen).toEqual(['o/app', 'nope']);
	});

	it('picks from a list, and gives null on cancel', async () => {
		vi.mocked(clack.select).mockResolvedValueOnce('github').mockResolvedValueOnce(cancel);
		const p = clackPrompter();
		const choices = [{ value: 'github', label: 'github', hint: 'issues' }];
		expect(await p.select('Tracker', choices, 'github')).toBe('github');
		expect(vi.mocked(clack.select).mock.calls[0]?.[0]).toMatchObject({
			options: choices,
			initialValue: 'github'
		});
		expect(await p.select('Tracker', choices)).toBeNull();
		expect(vi.mocked(clack.select).mock.calls[1]?.[0]).not.toHaveProperty('initialValue');
	});

	it('lets every item of a multi-select be unticked, and gives null on cancel', async () => {
		vi.mocked(clack.multiselect).mockResolvedValueOnce([]).mockResolvedValueOnce(cancel);
		const p = clackPrompter();
		const choices = [{ value: 'npm test', label: 'npm test' }];
		expect(await p.multiselect('Commands', choices, ['npm test'])).toEqual([]);
		expect(vi.mocked(clack.multiselect).mock.calls[0]?.[0]).toMatchObject({
			required: false,
			initialValues: ['npm test']
		});
		expect(await p.multiselect('Commands', choices, [])).toBeNull();
	});

	it('confirms, and gives null on cancel', async () => {
		vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(cancel);
		const p = clackPrompter();
		expect(await p.confirm('Run doctor?', true)).toBe(false);
		expect(await p.confirm('Run doctor?', true)).toBeNull();
	});
});
