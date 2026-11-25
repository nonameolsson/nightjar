// .factory/measures.json: what the Code host last said of each pull request, so the Measures read it at most once an hour and a merged pull request never again.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { CodeHost, Pull, PullState } from './code-host.js';
import { why } from './say.js';

export const PULL_STATES_EVERY_MS = 60 * 60_000;

export const measuresPath = (root: string) => join(root, '.factory', 'measures.json');

const CacheSchema = z.object({
	readAt: z.string(),
	states: z.record(
		z.string(),
		z.object({
			merged: z.boolean(),
			commits: z.array(z.object({ message: z.string(), at: z.string() }))
		})
	),
	fault: z.string().optional()
});

export interface PullStatesCache {
	// when the Code host was last asked, as an ISO time
	readonly readAt: string;
	// the state of each pull request, by its url
	readonly states: Readonly<Record<string, PullState>>;
	// why the last read left a pull request unread
	readonly fault?: string | undefined;
}

// The file, or null when it is missing or does not parse.
export function readPullStates(path: string): PullStatesCache | null {
	try {
		const parsed = CacheSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function writePullStates(path: string, cache: PullStatesCache): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${String(process.pid)}.tmp`;
	writeFileSync(temp, `${JSON.stringify(cache, null, '\t')}\n`);
	renameSync(temp, path);
}

// A pull request's id is the last number of its url, as GitHub's `/pull/12` and Azure Repos' `/pullrequest/12` end.
export function pullOfUrl(url: string): Pull | null {
	const last = /(\d+)\/?$/.exec(url.split(/[?#]/)[0] ?? '')?.[1];
	return last === undefined ? null : { id: Number(last), url };
}

// Asks the Code host about each of `urls`, unless it was asked less than an hour ago; says whether it asked. A merged pull request is kept as it was: it cannot change. A pull request the Code host fails on keeps its last state, and the fault is written down with the time, so a Code host that is down is not asked again at once.
export async function refreshPullStates(o: {
	readonly path: string;
	readonly codeHost: Required<Pick<CodeHost, 'pullState'>>;
	readonly urls: readonly string[];
	readonly now: Date;
}): Promise<boolean> {
	const { path, codeHost, urls, now } = o;
	const cache = readPullStates(path);
	const readAt = Date.parse(cache?.readAt ?? '');
	const age = now.getTime() - readAt;
	if (!Number.isNaN(readAt) && age >= 0 && age < PULL_STATES_EVERY_MS) return false;
	const states: Record<string, PullState> = {};
	let fault: string | undefined;
	for (const url of new Set(urls)) {
		const known: PullState | undefined = cache?.states[url];
		if (known?.merged === true) {
			states[url] = known;
			continue;
		}
		const pull = pullOfUrl(url);
		if (pull === null) continue;
		try {
			states[url] = await codeHost.pullState(pull);
		} catch (failure) {
			fault ??= `${url}: ${why(failure)}`;
			if (known !== undefined) states[url] = known;
		}
	}
	writePullStates(path, {
		readAt: now.toISOString(),
		states,
		...(fault === undefined ? {} : { fault })
	});
	return true;
}
