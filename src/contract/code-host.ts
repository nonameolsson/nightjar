// The Code host contract (docs/adr/0001): what every Code host Adapter must do, fake, built in or a repo's own.
import assert from 'node:assert/strict';
import type { CodeHost, Pull } from '../code-host.js';
import type { ContractCase } from './case.js';

// A pull request as the host shows it to a person.
export interface PullView {
	readonly title: string;
	readonly head: string;
	readonly base: string;
	readonly body: string;
	readonly draft: boolean;
	// the Ticket references the host links the pull request to, by their text
	readonly references: readonly string[];
	readonly comments: readonly string[];
}

export interface CodeHostSubject {
	readonly codeHost: CodeHost;
	// a branch on the host that pull requests can target
	readonly base: string;
	// makes one more commit in a worktree of the repo, ready to push
	readonly commit: () => Promise<{ readonly folder: string; readonly commit: string }>;
	// the commit `branch` points at on the host, else null
	readonly branch: (name: string) => Promise<string | null>;
	readonly pull: (pull: Pull) => Promise<PullView>;
	// called after the case, pass or fail
	readonly close?: () => Promise<void>;
}

// Makes a Code host with an empty repo that has only its base branch.
export type CodeHostHarness = () => Promise<CodeHostSubject>;

function codeHostCase(
	name: string,
	check: (subject: CodeHostSubject) => Promise<void>
): ContractCase<CodeHostHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness();
			try {
				await check(subject);
			} finally {
				await subject.close?.();
			}
		}
	};
}

export const codeHostContract: readonly ContractCase<CodeHostHarness>[] = [
	codeHostCase(
		"pushes a worktree's HEAD to a branch, and moves it on with a later push",
		async ({ codeHost, commit, branch }) => {
			const first = await commit();
			await codeHost.push(first.folder, 'factory/1-a');
			assert.equal(await branch('factory/1-a'), first.commit);
			assert.equal(await branch('factory/2-b'), null);
			const second = await commit();
			await codeHost.push(second.folder, 'factory/1-a');
			assert.equal(await branch('factory/1-a'), second.commit);
		}
	),

	codeHostCase(
		'opens a draft pull request with the title, branch, base and body it is given',
		async ({ codeHost, commit, base, pull }) => {
			await codeHost.push((await commit()).folder, 'factory/1-a');
			const body = 'Nightjar built all of it.\n\n## Built\n\n- `$(x)` "quoted" & <b>more</b>';
			const opened = await codeHost.createDraft({
				title: 'One $(escape)',
				head: 'factory/1-a',
				base,
				body
			});
			assert.ok(opened.url !== '', 'the pull request has a URL');
			const shown = await pull(opened);
			assert.deepEqual(
				{ title: shown.title, head: shown.head, base: shown.base, draft: shown.draft },
				{ title: 'One $(escape)', head: 'factory/1-a', base, draft: true }
			);
			assert.ok(shown.body.includes(body), `the body holds what it was given:\n${shown.body}`);
			assert.deepEqual(shown.references, []);
			assert.deepEqual(shown.comments, []);
		}
	),

	codeHostCase(
		'finds the open pull request of a branch, and none for a branch without one',
		async ({ codeHost, commit, base }) => {
			const { folder } = await commit();
			assert.equal(await codeHost.openPull('factory/1-a'), null);
			await codeHost.push(folder, 'factory/1-a');
			await codeHost.push(folder, 'factory/2-b');
			await codeHost.push(folder, 'factory/3-c');
			const one = await codeHost.createDraft({ title: 'A', head: 'factory/1-a', base, body: 'a' });
			const two = await codeHost.createDraft({ title: 'B', head: 'factory/2-b', base, body: 'b' });
			assert.notEqual(one.id, two.id);
			assert.deepEqual(await codeHost.openPull('factory/1-a'), one);
			assert.deepEqual(await codeHost.openPull('factory/2-b'), two);
			assert.equal(await codeHost.openPull('factory/3-c'), null);
		}
	),

	codeHostCase('replaces the body of a pull request', async ({ codeHost, commit, base, pull }) => {
		await codeHost.push((await commit()).folder, 'factory/1-a');
		const opened = await codeHost.createDraft({
			title: 'A',
			head: 'factory/1-a',
			base,
			body: 'First body'
		});
		await codeHost.editBody(opened, 'Second body, with `$(x)` & "quotes"');
		const { body } = await pull(opened);
		assert.ok(body.includes('Second body, with `$(x)` & "quotes"'), `the new body:\n${body}`);
		assert.ok(!body.includes('First body'), `the old body is gone:\n${body}`);
	}),

	codeHostCase(
		'places each Ticket reference once, and keeps them all when the body is replaced',
		async ({ codeHost, commit, base, pull }) => {
			await codeHost.push((await commit()).folder, 'factory/1-a');
			const opened = await codeHost.createDraft({
				title: 'A',
				head: 'factory/1-a',
				base,
				body: 'First body'
			});
			const sorted = async () => [...(await pull(opened)).references].sort();
			await codeHost.placeReferences(opened, [
				{ id: 2, text: '#2' },
				{ id: 3, text: '#3' }
			]);
			assert.deepEqual(await sorted(), ['#2', '#3']);
			await codeHost.placeReferences(opened, [
				{ id: 1, text: '#1' },
				{ id: 3, text: '#3' }
			]);
			assert.deepEqual(await sorted(), ['#1', '#2', '#3']);
			await codeHost.editBody(opened, 'Second body');
			assert.deepEqual(await sorted(), ['#1', '#2', '#3']);
			await codeHost.placeReferences(opened, []);
			assert.deepEqual(await sorted(), ['#1', '#2', '#3']);
			assert.ok((await pull(opened)).body.includes('Second body'));
		}
	),

	codeHostCase(
		'comments on a pull request, oldest first, with the body unchanged',
		async ({ codeHost, commit, base, pull }) => {
			await codeHost.push((await commit()).folder, 'factory/1-a');
			const opened = await codeHost.createDraft({
				title: 'A',
				head: 'factory/1-a',
				base,
				body: 'a'
			});
			const review = '**Nightjar review: changes**\n\n- `src/a.ts:3`: $(x) & "y"';
			await codeHost.comment(opened, review);
			await codeHost.comment(opened, 'Second');
			assert.deepEqual((await pull(opened)).comments, [review, 'Second']);
		}
	)
];
