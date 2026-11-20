// The Conflicts section of a pull request body: Nightjar only says that the draft conflicts with its base, and never merges or rebases the base into it (docs/adr/0007).
import type { CodeHost, Conflict, Pull } from './code-host.js';

// About ten seconds in all: GitHub works out whether a pull request merges only when it is asked, and answers unknown until it has.
const CONFLICT_READS = 6;
const CONFLICT_WAIT_MS = 2_000;

// The section for a pull request that conflicts with `base`.
export function conflictSection(base: string): string {
	return `## Conflicts with ${base}\n\nThis pull request conflicts with \`${base}\`: merge or rebase \`${base}\` before review.`;
}

// The body with the section, after its opening line and before its first heading; at the end of a body without one.
export function withConflict(body: string, base: string): string {
	const section = conflictSection(base);
	const at = body.indexOf('\n\n## ');
	return at < 0 ? `${body}\n\n${section}` : `${body.slice(0, at)}\n\n${section}${body.slice(at)}`;
}

// Whether the pull request conflicts with its base: read again after a wait while the Code host says unknown, and unknown when it stays so or the Code host cannot say.
export async function conflictOf(
	codeHost: Pick<CodeHost, 'conflicts'>,
	pull: Pull,
	sleep: (ms: number) => Promise<void>
): Promise<Conflict> {
	if (codeHost.conflicts === undefined) return 'unknown';
	for (let read = 1; ; read += 1) {
		const state = await codeHost.conflicts(pull);
		if (state !== 'unknown' || read === CONFLICT_READS) return state;
		await sleep(CONFLICT_WAIT_MS);
	}
}
