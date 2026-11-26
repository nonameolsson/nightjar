// The pullState contract (docs/custom-adapters.md): run over a Code host that has the optional `pullState`.
import assert from 'node:assert/strict';
import type { CodeHost, Pull, PullState } from '../code-host.js';
import type { ContractCase } from './case.js';
import type { CodeHostHarness, CodeHostSubject, DraftsWorld } from './code-host.js';

type Reading = Omit<CodeHostSubject, 'codeHost' | 'drafts'> & {
	readonly codeHost: CodeHost & { pullState: (pull: Pull) => Promise<PullState> };
	readonly drafts: DraftsWorld & { merge: (pull: Pull) => Promise<void> };
	// a pushed branch, whose last commit has `message`, with a draft pull request on it
	readonly opened: (branch: string, message?: string) => Promise<Pull>;
};

function pullStateCase(
	name: string,
	check: (subject: Reading) => Promise<void>
): ContractCase<CodeHostHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness();
			try {
				const { codeHost, drafts } = subject;
				assert.ok(codeHost.pullState !== undefined, 'the Code host has pullState');
				assert.ok(drafts?.merge !== undefined, 'the harness lets a person merge a pull request');
				const opened = async (branch: string, message?: string) => {
					await codeHost.push((await subject.commit(message)).folder, branch);
					return codeHost.createDraft({
						title: branch,
						head: branch,
						base: subject.base,
						body: `Body of ${branch}`
					});
				};
				await check({
					...subject,
					codeHost: codeHost as Reading['codeHost'],
					drafts: drafts as Reading['drafts'],
					opened
				});
			} finally {
				await subject.close?.();
			}
		}
	};
}

const BUILT = 'Build #2 Share the function\n\nFactory-Ticket: 2';
const BY_PERSON = 'Fix a typo';

export const pullStateContract: readonly ContractCase<CodeHostHarness>[] = [
	pullStateCase('says a pull request still open is not merged', async ({ codeHost, opened }) => {
		const pull = await opened('factory/1-a');
		assert.equal((await codeHost.pullState(pull)).merged, false);
	}),

	pullStateCase(
		'says a pull request closed without merging is not merged',
		async ({ codeHost, opened, drafts }) => {
			const pull = await opened('factory/1-a');
			await drafts.closePull(pull);
			assert.equal((await codeHost.pullState(pull)).merged, false);
		}
	),

	pullStateCase(
		'says a merged pull request is merged, and still gives its commits',
		async ({ codeHost, opened, drafts }) => {
			const pull = await opened('factory/1-a', BUILT);
			await drafts.merge(pull);
			const state = await codeHost.pullState(pull);
			assert.equal(state.merged, true);
			assert.ok(
				state.commits.at(-1)?.message.startsWith('Build #2 Share the function'),
				`the branch's last commit:\n${JSON.stringify(state.commits)}`
			);
		}
	),

	pullStateCase(
		'gives the commits of its branch, oldest first, each with its whole message, trailers too',
		async ({ codeHost, opened, commit }) => {
			const pull = await opened('factory/1-a', BUILT);
			await codeHost.push((await commit(BY_PERSON)).folder, 'factory/1-a');
			const { commits } = await codeHost.pullState(pull);
			assert.ok(commits.length >= 2, `two commits at least; got ${String(commits.length)}`);
			const [built, typo] = commits.slice(-2);
			assert.ok(built?.message.includes('Factory-Ticket: 2'), built?.message);
			assert.equal(typo?.message.trim(), BY_PERSON);
			const times = commits.map((c) => Date.parse(c.at));
			assert.ok(
				times.every((t) => !Number.isNaN(t)),
				'each commit has a time'
			);
			assert.deepEqual(
				times,
				[...times].sort((x, y) => x - y),
				'the commits are oldest first'
			);
		}
	),

	pullStateCase(
		'reads the pull request it is given, not another',
		async ({ codeHost, opened, drafts }) => {
			const one = await opened('factory/1-a');
			const two = await opened('factory/2-b');
			await drafts.merge(two);
			assert.equal((await codeHost.pullState(one)).merged, false);
			assert.equal((await codeHost.pullState(two)).merged, true);
		}
	)
];
