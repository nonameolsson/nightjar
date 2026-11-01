// The Code host suite is no rubber stamp: a Code host that breaks one rule fails the case for it.
import { describe, expect, it } from 'vitest';
import type { CodeHost } from '../code-host.js';
import { FakeCodeHost } from '../fakes/code-host.js';
import { fakeCodeHostHarness, fakeCodeHostSubject } from '../fakes/harness.js';
import { codeHostContract, type CodeHostHarness } from './code-host.js';

function broken(over: (host: CodeHost) => Partial<CodeHost>): CodeHostHarness {
	return async () => {
		const subject = await fakeCodeHostHarness();
		const host = subject.codeHost;
		return { ...subject, codeHost: { ...host, ...over(host) } };
	};
}

function caseNamed(start: string) {
	const found = codeHostContract.find((c) => c.name.startsWith(start));
	if (found === undefined) throw new Error(`no Code host case starts with ${start}`);
	return found;
}

describe('the Code host contract', () => {
	it('fails a Code host that pushes only the first time', async () => {
		const pushed = new Set<string>();
		const harness = broken((h) => ({
			push: async (folder, branch) => {
				if (!pushed.has(branch)) await h.push(folder, branch);
				pushed.add(branch);
			}
		}));
		await expect(caseNamed("pushes a worktree's HEAD").run(harness)).rejects.toThrow();
	});

	it('fails a Code host that opens a pull request that is no draft', async () => {
		const harness: CodeHostHarness = async () => {
			const subject = await fakeCodeHostHarness();
			return { ...subject, pull: async (p) => ({ ...(await subject.pull(p)), draft: false }) };
		};
		await expect(caseNamed('opens a draft pull request').run(harness)).rejects.toThrow();
	});

	it('fails a Code host that finds a pull request for any branch', async () => {
		const harness = broken((h) => ({
			openPull: async (branch) => (await h.openPull(branch)) ?? h.openPull('factory/1-a')
		}));
		await expect(caseNamed('finds the open pull request').run(harness)).rejects.toThrow();
	});

	it('fails a Code host that keeps the old body', async () => {
		const harness = broken((h) => ({ editBody: (pull, body) => h.comment(pull, body) }));
		await expect(caseNamed('replaces the body').run(harness)).rejects.toThrow();
	});

	it('fails a Code host that places a reference twice', async () => {
		const harness: CodeHostHarness = async () => {
			const subject = await fakeCodeHostHarness();
			return {
				...subject,
				pull: async (p) => {
					const shown = await subject.pull(p);
					return { ...shown, references: [...shown.references, ...shown.references] };
				}
			};
		};
		await expect(caseNamed('places each Ticket reference once').run(harness)).rejects.toThrow();
	});

	it('fails a Code host that loses the references when the body is replaced', async () => {
		const harness: CodeHostHarness = () => {
			const fake = new FakeCodeHost();
			const { editBody } = fake;
			fake.editBody = async (pull, body) => {
				await editBody(pull, body);
				fake.pulls = fake.pulls.map((p) => (p.id === pull.id ? { ...p, references: [] } : p));
			};
			return Promise.resolve(fakeCodeHostSubject(fake));
		};
		await expect(caseNamed('places each Ticket reference once').run(harness)).rejects.toThrow();
	});

	it('fails a Code host that drops a comment', async () => {
		const harness = broken(() => ({ comment: () => Promise.resolve() }));
		await expect(caseNamed('comments on a pull request').run(harness)).rejects.toThrow();
	});
});
