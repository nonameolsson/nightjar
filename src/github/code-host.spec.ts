import { describe, expect, it } from 'vitest';
import type { Run } from '../git.js';
import { GitHubFailure } from './api.js';
import { GitHubCodeHost, type GitRunner } from './code-host.js';
import { failed, fakeGh, ok, on, type GhCall } from './fake-gh.js';

const noGit: GitRunner = () => Promise.resolve(failed('no git here'));

// one pull request, #9, whose body the fake keeps as GitHub would
function onePull(body = '') {
	let current = body;
	const pull = () => ({ number: 9, html_url: 'https://github.com/o/r/pull/9', body: current });
	const routes = [
		on('GET', 'repos/o/r/pulls/9', () => ok(pull())),
		on('PATCH', 'repos/o/r/pulls/9', (call: GhCall) => {
			current = String(call.fields.body);
			return ok(pull());
		})
	];
	return { routes, body: () => current };
}

const PULL = { id: 9, url: 'https://github.com/o/r/pull/9' };

describe('GitHubCodeHost', () => {
	it("pushes the worktree's HEAD to the branch on origin", async () => {
		const ran: { args: readonly string[]; cwd: string }[] = [];
		const git: GitRunner = (args, cwd) => {
			ran.push({ args, cwd });
			return Promise.resolve<Run>({ ok: true, out: '', err: '', missing: false });
		};
		await new GitHubCodeHost('o/r', fakeGh().gh, git).push('/work/1-a', 'factory/1-a');
		expect(ran).toEqual([
			{ args: ['push', '-q', '-u', 'origin', 'HEAD:refs/heads/factory/1-a'], cwd: '/work/1-a' }
		]);
	});

	it('names the reason a push failed', async () => {
		const git: GitRunner = () =>
			Promise.resolve(failed('remote: Permission denied\nfatal: unable to access'));
		await expect(
			new GitHubCodeHost('o/r', fakeGh().gh, git).push('/w', 'factory/1-a')
		).rejects.toThrow(
			new GitHubFailure('git could not push factory/1-a: remote: Permission denied')
		);
	});

	it('finds the open pull request of a branch, or none', async () => {
		const { gh, calls } = fakeGh(
			on('GET', 'repos/o/r/pulls', (call) =>
				ok(
					call.query.get('head') === 'o:factory/1-a'
						? [{ number: 9, html_url: 'https://github.com/o/r/pull/9' }]
						: []
				)
			)
		);
		const host = new GitHubCodeHost('o/r', gh, noGit);
		expect(await host.openPull('factory/1-a')).toEqual(PULL);
		expect(await host.openPull('factory/2-b')).toBeNull();
		expect(calls[0]?.query.get('state')).toBe('open');
	});

	it('opens a draft pull request with each field as its own argument', async () => {
		const { gh, calls } = fakeGh(
			on('POST', 'repos/o/r/pulls', ok({ number: 9, html_url: 'https://github.com/o/r/pull/9' }))
		);
		const pull = await new GitHubCodeHost('o/r', gh, noGit).createDraft({
			title: 'A $(title)',
			head: 'factory/1-a',
			base: 'main',
			body: 'The body'
		});
		expect(pull).toEqual(PULL);
		expect(calls[0]?.fields).toEqual({
			title: 'A $(title)',
			head: 'factory/1-a',
			base: 'main',
			body: 'The body',
			draft: 'true'
		});
	});

	it('places each Ticket reference once as a Closes line, and keeps them when the body is edited', async () => {
		const pull = onePull('First body');
		const host = new GitHubCodeHost('o/r', fakeGh(...pull.routes).gh, noGit);
		await host.placeReferences(PULL, [
			{ id: '2', text: '#2' },
			{ id: '3', text: '#3' }
		]);
		await host.placeReferences(PULL, [
			{ id: '1', text: '#1' },
			{ id: '3', text: '#3' }
		]);
		await host.editBody(PULL, 'Second body');
		const body = pull.body();
		expect(body.startsWith('Second body\n\n')).toBe(true);
		expect(body).not.toContain('First body');
		expect(body.match(/^Closes .*$/gm)).toEqual(['Closes #2', 'Closes #3', 'Closes #1']);
	});

	it('comments on the pull request', async () => {
		const { gh, calls } = fakeGh(on('POST', 'repos/o/r/issues/9/comments', ok({})));
		await new GitHubCodeHost('o/r', gh, noGit).comment(PULL, 'A review');
		expect(calls[0]?.fields).toEqual({ body: 'A review' });
	});
});
