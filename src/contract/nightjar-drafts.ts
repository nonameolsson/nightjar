// The nightjarDrafts contract (docs/custom-adapters.md): run over a Code host that has the optional method.
import assert from 'node:assert/strict';
import type { CodeHost, DraftsListing, NightjarDraft, Pull } from '../code-host.js';
import { markPublished, publishedByNightjar } from '../publish.js';
import type { ContractCase } from './case.js';
import type { CodeHostHarness, CodeHostSubject, DraftsWorld } from './code-host.js';

type Listing = Omit<CodeHostSubject, 'codeHost' | 'drafts'> & {
	readonly codeHost: CodeHost & {
		nightjarDrafts: (listing?: DraftsListing) => Promise<NightjarDraft[]>;
	};
	readonly drafts: DraftsWorld;
	// a pushed branch with a draft pull request on it
	readonly opened: (
		branch: string,
		o?: string | { body?: string; message?: string }
	) => Promise<Pull>;
};

function draftsCase(
	name: string,
	check: (subject: Listing) => Promise<void>
): ContractCase<CodeHostHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness();
			try {
				const { codeHost, drafts } = subject;
				assert.ok(codeHost.nightjarDrafts !== undefined, 'the Code host has nightjarDrafts');
				assert.ok(drafts !== undefined, 'the harness gives the drafts world');
				const opened = async (
					branch: string,
					o: string | { body?: string; message?: string } = {}
				) => {
					const { body = `Body of ${branch}`, message } = typeof o === 'string' ? { body: o } : o;
					await codeHost.push((await subject.commit(message)).folder, branch);
					return codeHost.createDraft({ title: branch, head: branch, base: subject.base, body });
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

const listed = async ({ codeHost }: Listing, listing?: DraftsListing) =>
	await codeHost.nightjarDrafts(listing);

const one = async (
	subject: Listing,
	pull: Pull,
	listing?: DraftsListing
): Promise<NightjarDraft> => {
	const found = (await listed(subject, listing)).find((d) => d.pull.id === pull.id);
	assert.ok(found !== undefined, `pull request ${String(pull.id)} is listed`);
	return found;
};

export const nightjarDraftsContract: readonly ContractCase<CodeHostHarness>[] = [
	draftsCase(
		"lists the open draft pull requests on Nightjar's branches, oldest first, with their branch, head commit and body",
		async (subject) => {
			const first = await subject.opened('factory/1-a', 'Nightjar built all of #1 A.');
			await subject.opened('person/fix-typo');
			const second = await subject.opened('factory/2-b');
			const drafts = await listed(subject);
			assert.deepEqual(
				drafts.map((d) => [d.pull, d.branch]),
				[
					[first, 'factory/1-a'],
					[second, 'factory/2-b']
				]
			);
			const [a] = drafts;
			assert.ok(a !== undefined);
			assert.equal(a.headCommit, await subject.branch('factory/1-a'));
			assert.ok(a.body.includes('Nightjar built all of #1 A.'), `the body:\n${a.body}`);
		}
	),

	draftsCase(
		'leaves out a pull request marked ready for review, and one closed',
		async (subject) => {
			const ready = await subject.opened('factory/1-a');
			const closed = await subject.opened('factory/2-b');
			const draft = await subject.opened('factory/3-c');
			await subject.drafts.ready(ready);
			await subject.drafts.closePull(closed);
			assert.deepEqual(
				(await listed(subject)).map((d) => d.pull),
				[draft]
			);
		}
	),

	draftsCase(
		'gives the Pull checks on the head commit: pending while one runs, each failure with its check, job, step and log tail, none when green',
		async (subject) => {
			const pull = await subject.opened('factory/1-a');
			await subject.drafts.checks(pull, { pending: true, failed: [] });
			assert.deepEqual((await one(subject, pull)).checks, { pending: true, failed: [] });

			const failure = {
				check: 'CI / test',
				job: 'test',
				step: 'Run npm test',
				logTail: 'FAIL src/a.spec.ts > a > works\nError: expected 1 to be 2'
			};
			await subject.drafts.checks(pull, { pending: false, failed: [failure] });
			const red = (await one(subject, pull)).checks;
			assert.equal(red.pending, false);
			assert.equal(red.failed.length, 1);
			const [got] = red.failed;
			assert.ok(got !== undefined);
			assert.deepEqual(
				{ check: got.check, job: got.job, step: got.step },
				{ check: failure.check, job: failure.job, step: failure.step }
			);
			assert.ok(got.logTail.includes('Error: expected 1 to be 2'), `the log tail:\n${got.logTail}`);

			await subject.drafts.checks(pull, { pending: false, failed: [] });
			assert.deepEqual((await one(subject, pull)).checks, { pending: false, failed: [] });
		}
	),

	draftsCase(
		'says a person engaged once another account reviews or comments, and not for its own comments',
		async (subject) => {
			const pull = await subject.opened('factory/1-a');
			assert.equal((await one(subject, pull)).personEngaged, false);
			await subject.codeHost.comment(pull, '**Nightjar review: approve**\n\nReads well.');
			assert.equal((await one(subject, pull)).personEngaged, false);
			await subject.drafts.engage(pull);
			assert.equal((await one(subject, pull)).personEngaged, true);
		}
	),

	draftsCase(
		'says when the pull request opened, and how many Pull checks the head commit has: none until the Code host registers one',
		async (subject) => {
			const first = await subject.opened('factory/1-a');
			const second = await subject.opened('factory/2-b');
			const a = await one(subject, first);
			const b = await one(subject, second);
			const opened = (d: NightjarDraft) => {
				const ms = Date.parse(d.openedAt ?? '');
				assert.ok(!Number.isNaN(ms), `it says when the pull request opened: ${String(d.openedAt)}`);
				return ms;
			};
			assert.ok(opened(a) <= opened(b), 'the later one opened no sooner');
			assert.equal(a.checkCount, 0);
			await subject.drafts.passed(first);
			assert.equal((await one(subject, first)).checkCount, 1);
			assert.equal((await one(subject, second)).checkCount, 0);
			await subject.drafts.checks(second, { pending: true, failed: [] });
			assert.equal((await one(subject, second)).checkCount, 1);
		}
	),

	draftsCase(
		'gives the commits of its branch when asked for them, oldest first, each with its whole message',
		async (subject) => {
			const built = 'Build #2 Share the function\n\nFactory-Ticket: 2\nFactory-Session: s-1';
			const pull = await subject.opened('factory/1-a', { message: built });
			const later = await subject.commit('Fix a typo');
			await subject.codeHost.push(later.folder, 'factory/1-a');
			const { commits } = await one(subject, pull, { commits: true });
			assert.ok(commits !== undefined, 'it lists the commits');
			assert.ok(commits.length >= 2, `two commits at least; got ${String(commits.length)}`);
			const [first, last] = [commits.at(-2), commits.at(-1)];
			assert.equal(first?.message.trim(), built);
			assert.equal(last?.message.trim(), 'Fix a typo');
		}
	),

	draftsCase(
		'lists a pull request Nightjar published, which its body marks, and leaves out one a person marked ready',
		async (subject) => {
			const { codeHost } = subject;
			// a Code host without the optional method never publishes, so it has none to list
			if (codeHost.publish === undefined) return;
			const own = await subject.opened('factory/1-a');
			const theirs = await subject.opened('factory/2-b');
			await codeHost.publish(own);
			await codeHost.editBody(own, markPublished('Body of factory/1-a'));
			await subject.drafts.ready(theirs);
			const listedNow = await listed(subject);
			assert.deepEqual(
				listedNow.map((d) => d.pull),
				[own]
			);
			assert.ok(publishedByNightjar(listedNow[0]?.body ?? ''));
		}
	),

	draftsCase('follows the head commit to a later push', async (subject) => {
		const pull = await subject.opened('factory/1-a');
		const before = (await one(subject, pull)).headCommit;
		const later = await subject.commit();
		await subject.codeHost.push(later.folder, 'factory/1-a');
		const after = (await one(subject, pull)).headCommit;
		assert.notEqual(after, before);
		assert.equal(after, later.commit);
	})
];
