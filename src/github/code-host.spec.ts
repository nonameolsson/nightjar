import { describe, expect, it } from 'vitest';
import type { Pull } from '../code-host.js';
import type { Run } from '../git.js';
import { GitHubFailure } from './api.js';
import { GitHubCodeHost, type GitRunner } from './code-host.js';
import { failed, fakeGh, ok, on, type GhCall } from './fake-gh.js';
import { FakeGitHub } from './fake-github.js';

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

	it('places a reference from another Tracker as it is, AB#N or PROJ-123, with no Closes', async () => {
		const pull = onePull('Body');
		const host = new GitHubCodeHost('o/r', fakeGh(...pull.routes).gh, noGit);
		await host.placeReferences(PULL, [
			{ id: '7', text: 'AB#7' },
			{ id: 'PROJ-123', text: 'PROJ-123' },
			{ id: '2', text: '#2' }
		]);
		const lines = pull.body().split('<!-- nightjar:references -->\n')[1]?.split('\n');
		expect(lines).toEqual(['AB#7', 'PROJ-123', 'Closes #2']);
	});

	it('comments on the pull request', async () => {
		const { gh, calls } = fakeGh(on('POST', 'repos/o/r/issues/9/comments', ok({})));
		await new GitHubCodeHost('o/r', gh, noGit).comment(PULL, 'A review');
		expect(calls[0]?.fields).toEqual({ body: 'A review' });
	});
});

// o/r signed in as nightjar-bot, whose draft pull requests a spec opens on a pushed branch.
function draftsWorld() {
	const github = new FakeGitHub('o/r', 'nightjar-bot');
	const host = new GitHubCodeHost('o/r', github.gh, noGit);
	const open = (branch: string, commit = `sha-${branch.replaceAll('/', '-')}`) => {
		github.pushed(branch, commit);
		return host.createDraft({
			title: branch,
			head: branch,
			base: 'main',
			body: `Body of ${branch}`
		});
	};
	const one = async (pull: Pull) => {
		const found = (await host.nightjarDrafts()).find((d) => d.pull.id === pull.id);
		if (found === undefined) throw new Error(`pull request ${String(pull.id)} is not listed`);
		return found;
	};
	return { github, host, open, one };
}

// each line stamped with its time, as GitHub writes an Actions log
const STAMPED_AT = '2026-11-04T06:53:39.1234567Z';
const stamped = (...lines: string[]) => lines.map((l) => `${STAMPED_AT} ${l}`).join('\n');

describe('GitHubCodeHost lists its drafts', () => {
	it("lists only open drafts on Nightjar's branches, oldest first, with their head commit and body", async () => {
		const { github, host, open } = draftsWorld();
		const first = await open('factory/1-a', 'abc1234');
		await open('person/fix-typo');
		const ready = await open('factory/2-b');
		const closed = await open('factory/3-c');
		const last = await open('factory/4-d');
		github.markReady(ready.id);
		github.close(closed.id);
		const drafts = await host.nightjarDrafts();
		expect(drafts.map((d) => [d.pull, d.branch])).toEqual([
			[first, 'factory/1-a'],
			[last, 'factory/4-d']
		]);
		expect(drafts[0]).toMatchObject({ headCommit: 'abc1234', body: 'Body of factory/1-a' });
	});

	it('leaves out a draft whose branch comes from a fork', async () => {
		const { gh } = fakeGh(
			on('GET', 'repos/o/r/pulls', () =>
				ok([
					{
						number: 9,
						html_url: 'https://github.com/o/r/pull/9',
						body: '',
						draft: true,
						head: { ref: 'factory/1-a', sha: 'abc', repo: { full_name: 'someone/r' } }
					}
				])
			)
		);
		expect(await new GitHubCodeHost('o/r', gh, noGit).nightjarDrafts()).toEqual([]);
	});

	it('has no Pull checks on a head commit nothing ran on', async () => {
		const { open, one } = draftsWorld();
		const pull = await open('factory/1-a');
		expect((await one(pull)).checks).toEqual({ pending: false, failed: [] });
	});

	it('is pending while a check is queued or in progress, or a commit status is pending', async () => {
		const { github, open, one } = draftsWorld();
		const pull = await open('factory/1-a', 'c1');
		for (const status of ['queued', 'in_progress']) {
			github.clearChecks('c1');
			github.checkRun('c1', { name: 'test', status });
			expect((await one(pull)).checks.pending).toBe(true);
		}
		github.clearChecks('c1');
		github.commitStatus('c1', { context: 'ci/circleci', state: 'pending' });
		expect((await one(pull)).checks.pending).toBe(true);
		github.commitStatus('c1', { context: 'ci/circleci', state: 'success' });
		github.checkRun('c1', { name: 'test', status: 'completed', conclusion: 'success' });
		expect((await one(pull)).checks).toEqual({ pending: false, failed: [] });
	});

	it('names a failed Actions job by its workflow and job, its failed step and the end of its log, without the times', async () => {
		const { github, open, one } = draftsWorld();
		const pull = await open('factory/1-a', 'c1');
		github.actionsJob('c1', {
			workflow: 'CI',
			name: 'test',
			conclusion: 'failure',
			steps: [
				{ name: 'Set up job', conclusion: 'success' },
				{ name: 'Run npm test', conclusion: 'failure' },
				{ name: 'Post Run actions/checkout@v4', conclusion: 'success' }
			],
			log: stamped(
				...Array.from({ length: 150 }, (_, i) => `line ${String(i)}`),
				'FAIL src/a.spec.ts > a > works',
				'##[error]Process completed with exit code 1.'
			)
		});
		github.checkRun('c1', { name: 'build', status: 'completed', conclusion: 'success' });
		const { checks } = await one(pull);
		expect(checks.pending).toBe(false);
		expect(checks.failed).toHaveLength(1);
		const [failed] = checks.failed;
		expect(failed).toMatchObject({ check: 'CI / test', job: 'test', step: 'Run npm test' });
		const tail = (failed?.logTail ?? '').split('\n');
		expect(tail).toHaveLength(100);
		expect(tail.at(-1)).toBe('##[error]Process completed with exit code 1.');
		expect(tail).not.toContain('line 0');
	});

	it('counts each red conclusion as failed, and neither skipped nor neutral', async () => {
		const { github, open, one } = draftsWorld();
		const pull = await open('factory/1-a', 'c1');
		for (const conclusion of ['failure', 'timed_out', 'cancelled', 'skipped', 'neutral']) {
			github.checkRun('c1', { name: conclusion, status: 'completed', conclusion, app: 'other' });
		}
		expect((await one(pull)).checks.failed.map((f) => f.check)).toEqual([
			'failure',
			'timed_out',
			'cancelled'
		]);
	});

	it("names a commit status, or another app's check run, by the check alone, with what it says", async () => {
		const { github, open, one } = draftsWorld();
		const pull = await open('factory/1-a', 'c1');
		github.commitStatus('c1', {
			context: 'ci/circleci: build',
			state: 'failure',
			description: 'Your tests failed on CircleCI'
		});
		github.commitStatus('c1', { context: 'deploy', state: 'error', description: null });
		github.checkRun('c1', {
			name: 'Snyk',
			status: 'completed',
			conclusion: 'failure',
			app: 'snyk',
			output: { title: '2 issues', summary: 'lodash has a known vulnerability' }
		});
		expect((await one(pull)).checks.failed).toEqual([
			{
				check: 'Snyk',
				job: '',
				step: '',
				logTail: '2 issues\nlodash has a known vulnerability'
			},
			{ check: 'ci/circleci: build', job: '', step: '', logTail: 'Your tests failed on CircleCI' },
			{ check: 'deploy', job: '', step: '', logTail: '' }
		]);
	});

	it('still names a failed Actions job whose log has expired', async () => {
		const { github, open, one } = draftsWorld();
		const pull = await open('factory/1-a', 'c1');
		github.actionsJob('c1', {
			workflow: 'CI',
			name: 'lint',
			conclusion: 'failure',
			steps: [{ name: 'Run npm run lint', conclusion: 'failure' }],
			log: null
		});
		expect((await one(pull)).checks.failed).toEqual([
			{ check: 'CI / lint', job: 'lint', step: 'Run npm run lint', logTail: '' }
		]);
	});

	it('reads a failed job once, however often its drafts are listed', async () => {
		const { github, host, open } = draftsWorld();
		await open('factory/1-a', 'c1');
		const id = github.actionsJob('c1', {
			workflow: 'CI',
			name: 'test',
			conclusion: 'failure',
			steps: [],
			log: stamped('red')
		});
		await host.nightjarDrafts();
		await host.nightjarDrafts();
		const logs = `repos/o/r/actions/jobs/${String(id)}/logs`;
		expect(github.calls.filter((c) => c.path === logs)).toHaveLength(1);
	});

	it('follows the head commit to a later push, whose checks are its own', async () => {
		const { github, open, one } = draftsWorld();
		const pull = await open('factory/1-a', 'c1');
		github.checkRun('c1', { name: 'test', status: 'completed', conclusion: 'failure', app: 'x' });
		github.pushed('factory/1-a', 'c2');
		expect(await one(pull)).toMatchObject({
			headCommit: 'c2',
			checks: { pending: false, failed: [] }
		});
	});

	it("is not engaged by the signed-in login's own comments and reviews", async () => {
		const { github, host, open, one } = draftsWorld();
		const pull = await open('factory/1-a');
		await host.comment(pull, '**Nightjar review: approve**');
		github.review(pull.id, 'nightjar-bot');
		expect((await one(pull)).personEngaged).toBe(false);
	});

	it('is engaged once another login comments', async () => {
		const { github, open, one } = draftsWorld();
		const pull = await open('factory/1-a');
		github.say(pull.id, 'bea', 'Why this change?');
		expect((await one(pull)).personEngaged).toBe(true);
	});

	it('is engaged once another login reviews, an inline comment too', async () => {
		const { github, open, one } = draftsWorld();
		const pull = await open('factory/1-a');
		const other = await open('factory/2-b');
		github.review(pull.id, 'bea', 'CHANGES_REQUESTED');
		expect((await one(pull)).personEngaged).toBe(true);
		expect((await one(other)).personEngaged).toBe(false);
	});

	it('reads the signed-in login once', async () => {
		const { github, host, open } = draftsWorld();
		await open('factory/1-a');
		await open('factory/2-b');
		await host.nightjarDrafts();
		await host.nightjarDrafts();
		expect(github.calls.filter((c) => c.path === 'user')).toHaveLength(1);
	});

	it('fails with the reason when GitHub cannot list the pull requests', async () => {
		const { github, host } = draftsWorld();
		github.signOut();
		await expect(host.nightjarDrafts()).rejects.toThrow(GitHubFailure);
	});
});
