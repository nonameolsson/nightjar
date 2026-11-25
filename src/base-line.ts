// A Feature's `**Base:**` line, the branch its own branch is cut from, and the hidden mark of the bot pull request a botPulls Source made it for.
import type { Pull } from './code-host.js';

// a branch name git reads as a branch and nothing else: no option, range, reflog or revision mark
const BRANCH = /^[\w][\w.+@/-]*$/;

const safeBranch = (branch: string): boolean =>
	BRANCH.test(branch) &&
	!branch.includes('..') &&
	!branch.includes('@{') &&
	!branch.includes('//') &&
	!branch.endsWith('/') &&
	!branch.endsWith('.') &&
	!branch.endsWith('.lock');

export const baseLine = (branch: string): string => `**Base:** ${branch}`;

const LINE = /^(?:\*\*)?Base:(?:\*\*)?[ \t]*(.*?)\s*$/im;

export type Base = { readonly branch: string } | { readonly fault: string };

// The branch a Feature's `**Base:**` line names, a fault when git could misread it, or null when the body has no such line.
export function baseOf(body: string): Base | null {
	const found = LINE.exec(body);
	if (found === null) return null;
	const branch = found[1] ?? '';
	if (!safeBranch(branch)) {
		return { fault: `its \`**Base:**\` line names \`${branch}\`, which is no branch name` };
	}
	return { branch };
}

export const botPullMarker = (pull: Pull): string =>
	`<!-- nightjar:bot-pull=${String(pull.id)} url=${pull.url} -->`;

const MARKER = /<!-- nightjar:bot-pull=(\d+) url=(https?:\/\/[^\s<>"]+) -->/;

// The bot pull request a Feature was made for, by its hidden mark; null when it has none.
export function botPullOf(body: string): Pull | null {
	const found = MARKER.exec(body);
	if (found === null) return null;
	return { id: Number(found[1]), url: found[2] ?? '' };
}
