import { describe, expect, it } from 'vitest';
import { branchFor, worktreesFor } from './worktree.js';

describe('worktreesFor', () => {
	it('keeps the worktrees in a Nightjar folder in the home directory, one per checkout', () => {
		const one = worktreesFor('/home/ann', '/work/app');
		const other = worktreesFor('/home/ann', '/elsewhere/app');
		expect(one).toMatch(/^\/home\/ann\/\.nightjar\/worktrees\/app-[0-9a-f]{8}$/);
		expect(other).toMatch(/^\/home\/ann\/\.nightjar\/worktrees\/app-[0-9a-f]{8}$/);
		expect(one).not.toBe(other);
		expect(worktreesFor('/home/ann', '/work/app')).toBe(one);
	});
});

describe('branchFor', () => {
	it('names the branch by the Feature and a short slug of its title', () => {
		expect(branchFor(12, 'Add a "dark" mode — at last!')).toBe(
			'factory/12-add-a-dark-mode-at-last'
		);
		expect(branchFor(7, '???')).toBe('factory/7');
	});
});
