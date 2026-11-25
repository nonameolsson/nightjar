// The botPulls contract (docs/custom-adapters.md): run over a Code host that has the optional `botPulls`.
import assert from 'node:assert/strict';
import type { BotPull, CodeHost, Pull } from '../code-host.js';
import type { ContractCase } from './case.js';
import type { CodeHostHarness, CodeHostSubject, DraftsWorld } from './code-host.js';

type Listing = Omit<CodeHostSubject, 'codeHost' | 'drafts'> & {
	readonly codeHost: CodeHost & {
		botPulls: (prefixes: readonly string[]) => Promise<BotPull[]>;
	};
	readonly drafts: DraftsWorld;
	// a pushed branch with a pull request on it, titled `title`, as a bot opens one
	readonly opened: (branch: string, title?: string) => Promise<Pull>;
};

function botPullsCase(
	name: string,
	check: (subject: Listing) => Promise<void>
): ContractCase<CodeHostHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness();
			try {
				const { codeHost, drafts } = subject;
				assert.ok(codeHost.botPulls !== undefined, 'the Code host has botPulls');
				assert.ok(drafts !== undefined, 'the harness gives the drafts world');
				const opened = async (branch: string, title = `Bump ${branch}`) => {
					await codeHost.push((await subject.commit()).folder, branch);
					const pull = await codeHost.createDraft({
						title,
						head: branch,
						base: subject.base,
						body: 'Release notes the bot copied in.'
					});
					// a bot's pull request is ready for review, not a draft
					await drafts.ready(pull);
					return pull;
				};
				await check({
					...subject,
					codeHost: codeHost as Listing['codeHost'],
					drafts,
					opened
				});
			} finally {
				await subject.close?.();
			}
		}
	};
}

const PREFIXES = ['dependabot/', 'renovate/'];

const one = async ({ codeHost }: Listing, pull: Pull): Promise<BotPull> => {
	const found = (await codeHost.botPulls(PREFIXES)).find((p) => p.pull.id === pull.id);
	assert.ok(found !== undefined, `pull request ${String(pull.id)} is listed`);
	return found;
};

export const botPullsContract: readonly ContractCase<CodeHostHarness>[] = [
	botPullsCase(
		'lists the open pull requests of branches under any prefix, oldest first, with their title, branch and head commit',
		async (subject) => {
			const first = await subject.opened(
				'dependabot/npm_and_yarn/left-pad-1.1.0',
				'Bump left-pad from 1.0.0 to 1.1.0'
			);
			await subject.opened('person/fix-typo');
			await subject.opened('factory/1-a');
			const second = await subject.opened('renovate/right-pad-2.x');
			const listed = await subject.codeHost.botPulls(PREFIXES);
			assert.deepEqual(
				listed.map((p) => [p.pull, p.branch]),
				[
					[first, 'dependabot/npm_and_yarn/left-pad-1.1.0'],
					[second, 'renovate/right-pad-2.x']
				]
			);
			const [a] = listed;
			assert.ok(a !== undefined);
			assert.equal(a.title, 'Bump left-pad from 1.0.0 to 1.1.0');
			assert.equal(a.headCommit, await subject.branch('dependabot/npm_and_yarn/left-pad-1.1.0'));
		}
	),

	botPullsCase('leaves out a closed pull request', async (subject) => {
		const closed = await subject.opened('dependabot/npm_and_yarn/left-pad-1.1.0');
		await subject.drafts.closePull(closed);
		assert.deepEqual(await subject.codeHost.botPulls(PREFIXES), []);
	}),

	botPullsCase('leaves out a pull request from a fork', async (subject) => {
		const { fork } = subject.drafts;
		assert.ok(fork !== undefined, 'the drafts world can move a pull request to a fork');
		const forked = await subject.opened('dependabot/npm_and_yarn/left-pad-1.1.0');
		const own = await subject.opened('dependabot/npm_and_yarn/right-pad-2.0.0');
		await fork(forked);
		assert.deepEqual(
			(await subject.codeHost.botPulls(PREFIXES)).map((p) => p.pull),
			[own]
		);
	}),

	botPullsCase(
		'gives the Pull checks on the head commit: still running, or finished with the failed ones named',
		async (subject) => {
			const pull = await subject.opened('dependabot/npm_and_yarn/left-pad-1.1.0');
			await subject.drafts.checks(pull, { pending: true, failed: [] });
			assert.equal((await one(subject, pull)).checks.pending, true);
			const failed = {
				check: 'CI / test',
				job: 'test',
				step: 'Run tests',
				logTail: 'FAIL src/pad.spec.ts\nTypeError: pad is not a function'
			};
			await subject.drafts.checks(pull, { pending: false, failed: [failed] });
			const { checks } = await one(subject, pull);
			assert.equal(checks.pending, false);
			assert.deepEqual(
				checks.failed.map((f) => f.check),
				['CI / test']
			);
			assert.ok(
				checks.failed[0]?.logTail.includes('TypeError: pad is not a function'),
				`the log tail:\n${checks.failed[0]?.logTail ?? ''}`
			);
		}
	)
];
