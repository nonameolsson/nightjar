// The Conflicts section of a draft pull request body: a notice while the draft conflicts with its base, and one block per Conflict fix that ran, added to it every fix.
import type { CodeHost, Pull } from './code-host.js';

// What one Conflict fix did, as the section tells it.
export interface ConflictFix {
	readonly round: number;
	// a merge pushed to the branch, or a fix that gave up with nothing pushed
	readonly outcome: 'fixed' | 'gave up';
	// the Session's summary of the resolution, or why the fix gave up
	readonly summary: string;
	// the files the Session resolved; for a fix that gave up, those the merge stopped on
	readonly files: readonly string[];
	// what the fix cost, the check's fix rounds in it
	readonly usd: number;
}

const START = '<!-- nightjar-conflicts-section -->';
const END = '<!-- /nightjar-conflicts-section -->';
const SECTION = new RegExp(`\\n\\n${START}\\n([\\s\\S]*?)\\n${END}(?=\\n\\n|$)`);
const FIRST_BLOCK = '### Conflict fix ';

// How long, and how often, to ask a Code host that has not worked out a pull request's state yet.
const TRIES = 10;
const WAIT_MS = 1000;

// The Conflict fix blocks the section holds, as written, or an empty string when it holds none.
function blocksOf(body: string): string {
	const inner = SECTION.exec(body)?.[1] ?? '';
	const at = inner.indexOf(FIRST_BLOCK);
	return at < 0 ? '' : inner.slice(at);
}

// Whether the body holds the record of a Conflict fix.
export function hasConflictFixes(body: string): boolean {
	return blocksOf(body) !== '';
}

// The body with its Conflicts section made of the notice (when `base` is given) and `blocks`, after the first paragraph, where a reviewer reads it first; no section at all when both are empty.
function withSection(body: string, base: string | null, blocks: string): string {
	const clean = body.replace(SECTION, '');
	if (base === null && blocks === '') return clean;
	const heading =
		base === null
			? '## Conflicts'
			: `## Conflicts with ${base}\n\nThis pull request conflicts with \`${base}\`: merge or rebase \`${base}\` before review.`;
	const section = `${START}\n${blocks === '' ? heading : `${heading}\n\n${blocks}`}\n${END}`;
	const at = clean.indexOf('\n\n');
	return at < 0
		? `${clean}\n\n${section}`
		: `${clean.slice(0, at)}\n\n${section}${clean.slice(at)}`;
}

// The body without the Conflicts notice an earlier run put in it; the blocks of the Conflict fixes stay.
export function withoutConflicts(body: string): string {
	return withSection(body, null, blocksOf(body));
}

// The body with the Conflicts notice naming `base`, the blocks of the Conflict fixes as they were.
export function withConflicts(body: string, base: string): string {
	return withSection(body, base, blocksOf(body));
}

function block(f: ConflictFix): string {
	// a summary may not close the section early
	const summary = f.summary.trim().replaceAll('<!--', '<!- -');
	const label = f.outcome === 'fixed' ? 'Resolved files' : 'Files the merge stopped on';
	const files =
		f.files.length === 0
			? ''
			: `\n\n${label}:\n\n${f.files.map((file) => `- \`${file}\``).join('\n')}`;
	return `${FIRST_BLOCK}${String(f.round)}: ${f.outcome}, $${f.usd.toFixed(2)}\n\n${summary}${files}`;
}

// The body with `fix` added to the Conflicts section, after the fixes before it: with the notice naming `base` while the draft `conflicting` still does, and without it once it does not.
export function withConflictFix(
	body: string,
	base: string,
	fix: ConflictFix,
	conflicting: boolean
): string {
	const earlier = blocksOf(body);
	const blocks = earlier === '' ? block(fix) : `${earlier}\n\n${block(fix)}`;
	return withSection(body, conflicting ? base : null, blocks);
}

// Whether the pull request conflicts with its base, asked again for about ten seconds while the Code host cannot say; a Code host without `conflicts` never says.
export async function conflicts(
	codeHost: CodeHost,
	pull: Pull,
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
	signal?: AbortSignal
): Promise<boolean> {
	if (codeHost.conflicts === undefined) return false;
	for (let ask = 0; ask <= TRIES; ask += 1) {
		const state = await codeHost.conflicts(pull);
		if (state !== 'unknown') return state === 'yes';
		if (ask < TRIES) await sleep(WAIT_MS, signal);
	}
	return false;
}
