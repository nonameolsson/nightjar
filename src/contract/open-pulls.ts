// The openPulls contract (docs/custom-adapters.md): run over a Code host that has the optional `openPulls`, besides `feedback` and `reply`.
import assert from 'node:assert/strict';
import type { CodeHost, OpenPull, Pull } from '../code-host.js';
import type { ContractCase } from './case.js';
import type { CodeHostHarness, CodeHostSubject, DraftsWorld, FeedbackBench } from './code-host.js';

type Listing = Omit<CodeHostSubject, 'codeHost' | 'drafts' | 'bench'> & {
	readonly codeHost: CodeHost & { openPulls: (prefix: string) => Promise<OpenPull[]> };
	readonly drafts: DraftsWorld;
	readonly bench: FeedbackBench;
	// a pushed branch with a draft pull request on it, its commit made with `message`
	readonly opened: (branch: string, o?: { body?: string; message?: string }) => Promise<Pull>;
};

function openPullsCase(
	name: string,
	check: (subject: Listing) => Promise<void>
): ContractCase<CodeHostHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness();
			try {
				const { codeHost, drafts, bench } = subject;
				assert.ok(codeHost.openPulls !== undefined, 'the Code host has openPulls');
				assert.ok(drafts !== undefined, 'the harness gives the drafts world');
				assert.ok(bench !== undefined, 'the harness gives a bench, to review a pull request');
				const opened = async (branch: string, o: { body?: string; message?: string } = {}) => {
					await codeHost.push((await subject.commit(o.message)).folder, branch);
					return codeHost.createDraft({
						title: branch,
						head: branch,
						base: subject.base,
						body: o.body ?? `Body of ${branch}`
					});
				};
				await check({
					...subject,
					codeHost: codeHost as Listing['codeHost'],
					drafts,
					bench,
					opened
				});
			} finally {
				await subject.close?.();
			}
		}
	};
}

const PREFIX = 'factory/';

const one = async ({ codeHost }: Listing, pull: Pull): Promise<OpenPull> => {
	const found = (await codeHost.openPulls(PREFIX)).find((p) => p.pull.id === pull.id);
	assert.ok(found !== undefined, `pull request ${String(pull.id)} is listed`);
	return found;
};

const time = (at: string, what: string): number => {
	const ms = Date.parse(at);
	assert.ok(!Number.isNaN(ms), `${what} has a time: ${at}`);
	return ms;
};

// a Feedback round's commit message, its trailers last
const ANSWERED =
	'Answer feedback on the pull request\n\nRenamed it.\n\nFactory-Feedback: review:1, comment:2\nFactory-Session: s-1';

export const openPullsContract: readonly ContractCase<CodeHostHarness>[] = [
	openPullsCase(
		'lists the open pull requests of branches with the prefix, draft or ready for review, oldest first, with their branch and body',
		async (subject) => {
			const first = await subject.opened('factory/1-a', { body: 'Nightjar built all of #1 A.' });
			await subject.opened('person/fix-typo');
			const ready = await subject.opened('factory/2-b');
			const closed = await subject.opened('factory/3-c');
			await subject.drafts.ready(ready);
			await subject.drafts.closePull(closed);
			const listed = await subject.codeHost.openPulls(PREFIX);
			assert.deepEqual(
				listed.map((p) => [p.pull, p.branch]),
				[
					[first, 'factory/1-a'],
					[ready, 'factory/2-b']
				]
			);
			const [a] = listed;
			assert.ok(a !== undefined);
			assert.ok(a.body.includes('Nightjar built all of #1 A.'), `the body:\n${a.body}`);
		}
	),

	openPullsCase(
		'gives the commits of its branch, oldest first, each with its whole message and when it was made',
		async (subject) => {
			const pull = await subject.opened('factory/1-a', { message: 'Build #2 Share the function' });
			const later = await subject.commit(ANSWERED);
			await subject.codeHost.push(later.folder, 'factory/1-a');
			const { commits } = await one(subject, pull);
			assert.ok(commits.length >= 2, `two commits at least; got ${String(commits.length)}`);
			const [built, answered] = commits.slice(-2);
			assert.ok(built?.message.startsWith('Build #2 Share the function'), built?.message);
			assert.equal(answered?.message.trim(), ANSWERED);
			const times = commits.map((c, i) => time(c.at, `commit ${String(i + 1)}`));
			assert.deepEqual(
				times,
				[...times].sort((x, y) => x - y),
				'the commits are oldest first'
			);
		}
	),

	openPullsCase(
		'gives each review that requested changes, oldest first, trusted as the host would trust its author, and no other review',
		async (subject) => {
			const pull = await subject.opened('factory/1-a');
			const changes = (author: string, trusted: boolean) =>
				subject.bench.give(pull, {
					kind: 'review',
					author,
					body: `Change it, says ${author}.`,
					trusted,
					changes: true
				});
			const ann = await changes('ann', true);
			await subject.bench.give(pull, {
				kind: 'review',
				author: 'ann',
				body: 'Looks good.',
				trusted: true,
				approval: true
			});
			await subject.bench.give(pull, {
				kind: 'review',
				author: 'ann',
				body: 'A thought.',
				trusted: true
			});
			const mallory = await changes('mallory', false);
			const { changesRequested } = await one(subject, pull);
			assert.deepEqual(
				changesRequested.map((r) => [r.id, r.author, r.trusted]),
				[
					[ann, 'ann', true],
					[mallory, 'mallory', false]
				]
			);
			for (const r of changesRequested) time(r.at, r.id);
		}
	),

	openPullsCase(
		'dates a request for changes made before a commit earlier than it, and one made after its push later',
		async (subject) => {
			const pull = await subject.opened('factory/1-a');
			const ask = (body: string) =>
				subject.bench.give(pull, {
					kind: 'review',
					author: 'ann',
					body,
					trusted: true,
					changes: true
				});
			const before = await ask('Rename it.');
			const answer = await subject.commit(ANSWERED);
			await subject.codeHost.push(answer.folder, 'factory/1-a');
			const after = await ask('Rename the file too.');
			const listed = await one(subject, pull);
			const answered = listed.commits.at(-1);
			assert.ok(answered !== undefined);
			const at = (id: string) => {
				const found = listed.changesRequested.find((r) => r.id === id);
				assert.ok(found !== undefined, `the request ${id} is listed`);
				return time(found.at, id);
			};
			const commit = time(answered.at, 'the answering commit');
			assert.ok(at(before) < commit, 'the request made before the commit is earlier');
			assert.ok(commit < at(after), 'the request made after the push is later');
		}
	)
];
