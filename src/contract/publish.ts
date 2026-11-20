// The publish contract (docs/custom-adapters.md): run over a Code host that has the optional `publish`.
import assert from 'node:assert/strict';
import type { CodeHost, Pull } from '../code-host.js';
import type { ContractCase } from './case.js';
import type { CodeHostHarness, CodeHostSubject } from './code-host.js';

type Publishing = Omit<CodeHostSubject, 'codeHost'> & {
	readonly codeHost: CodeHost & { publish: (pull: Pull) => Promise<void> };
	// a pushed branch with a draft pull request on it
	readonly opened: (branch: string) => Promise<Pull>;
};

function publishCase(
	name: string,
	check: (subject: Publishing) => Promise<void>
): ContractCase<CodeHostHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness();
			try {
				const { codeHost } = subject;
				assert.ok(codeHost.publish !== undefined, 'the Code host has publish');
				const opened = async (branch: string) => {
					await codeHost.push((await subject.commit()).folder, branch);
					return codeHost.createDraft({
						title: branch,
						head: branch,
						base: subject.base,
						body: `Body of ${branch}`
					});
				};
				await check({ ...subject, codeHost: codeHost as Publishing['codeHost'], opened });
			} finally {
				await subject.close?.();
			}
		}
	};
}

export const publishContract: readonly ContractCase<CodeHostHarness>[] = [
	publishCase(
		'takes a draft pull request out of draft, and leaves it open with its title, body, references and comments',
		async ({ codeHost, opened, pull }) => {
			const draft = await opened('factory/1-a');
			await codeHost.placeReferences(draft, [{ id: '1', text: '#1' }]);
			await codeHost.comment(draft, '**Nightjar review: approve**');
			const before = await pull(draft);
			assert.equal(before.draft, true);
			await codeHost.publish(draft);
			const after = await pull(draft);
			assert.equal(after.draft, false, 'the pull request is no draft');
			assert.deepEqual({ ...after, draft: true }, before);
			assert.deepEqual(
				await codeHost.openPull('factory/1-a'),
				draft,
				'the pull request is still open'
			);
		}
	),

	publishCase('publishes only the pull request it is given', async ({ codeHost, opened, pull }) => {
		const one = await opened('factory/1-a');
		const two = await opened('factory/2-b');
		await codeHost.publish(two);
		assert.equal((await pull(one)).draft, true);
		assert.equal((await pull(two)).draft, false);
	}),

	publishCase(
		'leaves a pull request already published as it is, without failing',
		async ({ codeHost, opened, pull }) => {
			const draft = await opened('factory/1-a');
			await codeHost.publish(draft);
			await codeHost.publish(draft);
			assert.equal((await pull(draft)).draft, false);
		}
	),

	publishCase(
		"drops the pull request from Nightjar's drafts, when the Code host lists them",
		async ({ codeHost, opened }) => {
			const one = await opened('factory/1-a');
			const two = await opened('factory/2-b');
			await codeHost.publish(one);
			if (codeHost.nightjarDrafts === undefined) return;
			assert.deepEqual(
				(await codeHost.nightjarDrafts()).map((d) => d.pull),
				[two]
			);
		}
	)
];
