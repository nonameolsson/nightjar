import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pull } from './code-host.js';
import { FakeCodeHost } from './fakes/code-host.js';
import {
	measuresPath,
	PULL_STATES_EVERY_MS,
	pullOfUrl,
	readPullStates,
	refreshPullStates
} from './measures-cache.js';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-measures-cache-'));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const at = new Date(2026, 9, 30, 9, 0);
const later = (ms: number) => new Date(at.getTime() + ms);

// Two pull requests on the in-memory Code host: the first built by Nightjar, the second with a commit of a person's.
async function twoPulls(host: FakeCodeHost): Promise<{ one: Pull; two: Pull }> {
	const open = async (branch: string, commits: readonly string[]) => {
		const pull = await host.createDraft({ title: branch, head: branch, base: 'main', body: 'b' });
		for (const message of commits) host.branchMovedByPerson(branch, message);
		return pull;
	};
	return {
		one: await open('factory/1-a', ['Build #1 A\n\nFactory-Ticket: #1']),
		two: await open('factory/2-b', ['Build #2 B\n\nFactory-Ticket: #2', 'Fix a typo'])
	};
}

describe('pullOfUrl', () => {
	it('reads the id of a pull request from the end of its url', () => {
		expect(pullOfUrl('https://github.com/o/app/pull/12')).toEqual({
			id: 12,
			url: 'https://github.com/o/app/pull/12'
		});
		expect(pullOfUrl('https://dev.azure.com/o/p/_git/r/pullrequest/7/')?.id).toBe(7);
		expect(pullOfUrl('https://code.example/pull/5?diff=split#files')?.id).toBe(5);
		expect(pullOfUrl('https://code.example/pulls')).toBeNull();
	});
});

describe('refreshPullStates', () => {
	it('writes what the Code host said to .factory/measures.json, with the time and the commits', async () => {
		const host = new FakeCodeHost();
		const { one, two } = await twoPulls(host);
		host.merge(one);
		const read = await refreshPullStates({
			path: measuresPath(root),
			codeHost: host,
			urls: [one.url, two.url],
			now: at
		});
		expect(read).toBe(true);
		const file = JSON.parse(readFileSync(measuresPath(root), 'utf8')) as {
			readAt: string;
			states: Record<string, { merged: boolean; commits: { message: string }[] }>;
		};
		expect(file.readAt).toBe(at.toISOString());
		expect(file.states[one.url]?.merged).toBe(true);
		expect(file.states[one.url]?.commits.map((c) => c.message)).toEqual([
			'Build #1 A\n\nFactory-Ticket: #1'
		]);
		expect(file.states[two.url]?.merged).toBe(false);
		expect(readPullStates(measuresPath(root))?.states[two.url]?.commits).toHaveLength(2);
	});

	it('asks the Code host at most once an hour, and never again about a merged pull request', async () => {
		const host = new FakeCodeHost();
		const { one, two } = await twoPulls(host);
		host.merge(one);
		const refresh = (now: Date) =>
			refreshPullStates({
				path: measuresPath(root),
				codeHost: host,
				urls: [one.url, two.url],
				now
			});
		const reads = () => [host.stateReads.get(one.id) ?? 0, host.stateReads.get(two.id) ?? 0];
		expect(await refresh(at)).toBe(true);
		expect(reads()).toEqual([1, 1]);

		// every minute of the hour after: nothing is asked
		for (let minute = 1; minute < 60; minute += 1) {
			expect(await refresh(later(minute * 60_000))).toBe(false);
		}
		expect(reads()).toEqual([1, 1]);

		// an hour on, the pull request still open is asked again, the merged one is not
		host.merge(two);
		expect(await refresh(later(PULL_STATES_EVERY_MS))).toBe(true);
		expect(reads()).toEqual([1, 2]);
		expect(readPullStates(measuresPath(root))?.states[two.url]?.merged).toBe(true);
	});

	it('asks again at once when the clock stands before the time it last asked', async () => {
		const host = new FakeCodeHost();
		const { one } = await twoPulls(host);
		await refreshPullStates({
			path: measuresPath(root),
			codeHost: host,
			urls: [one.url],
			now: at
		});
		const asked = await refreshPullStates({
			path: measuresPath(root),
			codeHost: host,
			urls: [one.url],
			now: later(-60_000)
		});
		expect(asked).toBe(true);
	});

	it('keeps the last state of a pull request the Code host fails on, says why, and waits the hour', async () => {
		const host = new FakeCodeHost();
		const { one, two } = await twoPulls(host);
		host.merge(one);
		await refreshPullStates({
			path: measuresPath(root),
			codeHost: host,
			urls: [one.url, two.url],
			now: at
		});
		let asked = 0;
		const failing = {
			pullState: () => {
				asked += 1;
				return Promise.reject(new Error('GitHub is down'));
			}
		};
		const refresh = (now: Date) =>
			refreshPullStates({
				path: measuresPath(root),
				codeHost: failing,
				urls: [one.url, two.url],
				now
			});
		expect(await refresh(later(PULL_STATES_EVERY_MS))).toBe(true);
		// the merged one is kept without asking
		expect(asked).toBe(1);
		const kept = readPullStates(measuresPath(root));
		expect(kept?.states[one.url]?.merged).toBe(true);
		expect(kept?.states[two.url]?.commits).toHaveLength(2);
		expect(kept?.fault).toContain('GitHub is down');
		expect(kept?.fault).toContain(two.url);
		// the failed read set the time too
		expect(await refresh(later(PULL_STATES_EVERY_MS + 60_000))).toBe(false);
		expect(asked).toBe(1);
	});

	it('drops what it kept of a pull request that has left the window', async () => {
		const host = new FakeCodeHost();
		const { one, two } = await twoPulls(host);
		await refreshPullStates({
			path: measuresPath(root),
			codeHost: host,
			urls: [one.url, two.url],
			now: at
		});
		await refreshPullStates({
			path: measuresPath(root),
			codeHost: host,
			urls: [two.url],
			now: later(PULL_STATES_EVERY_MS)
		});
		expect(Object.keys(readPullStates(measuresPath(root))?.states ?? {})).toEqual([two.url]);
	});

	it('reads nothing from a file that is missing or not its own', () => {
		expect(readPullStates(measuresPath(root))).toBeNull();
	});
});
