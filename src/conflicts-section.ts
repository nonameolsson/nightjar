// The Conflicts section of a draft pull request body: said when the draft conflicts with its base, and nothing else.
import type { CodeHost, Pull } from './code-host.js';

const START = '<!-- nightjar-conflicts-section -->';
const END = '<!-- /nightjar-conflicts-section -->';
const SECTION = new RegExp(`${START}\\n[\\s\\S]*?\\n${END}\\n\\n`);

// How long, and how often, to ask a Code host that has not worked out a pull request's state yet.
const TRIES = 10;
const WAIT_MS = 1000;

// The body without a Conflicts section an earlier run put in it.
export function withoutConflicts(body: string): string {
	return body.replace(SECTION, '');
}

// The body with the Conflicts section after its first paragraph, where a reviewer reads it first.
export function withConflicts(body: string, base: string): string {
	const clean = withoutConflicts(body);
	const section = `${START}\n## Conflicts with ${base}\n\nThis pull request conflicts with \`${base}\`: merge or rebase \`${base}\` before review.\n${END}`;
	const at = clean.indexOf('\n\n');
	return at < 0
		? `${clean}\n\n${section}`
		: `${clean.slice(0, at)}\n\n${section}${clean.slice(at)}`;
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
