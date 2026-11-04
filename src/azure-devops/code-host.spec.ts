import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NightjarDraft, Pull } from '../code-host.js';
import { run, type Env, type Run } from '../git.js';
import { AzureDevOpsApi, AzureDevOpsFailure } from './api.js';
import {
	AzureReposCodeHost,
	DESCRIPTION_LIMIT,
	REFERENCES_MARK,
	type AzureGitRunner
} from './code-host.js';
import { FakeAzureDevOps } from './fake-azure-devops.js';
import type { AzureDevOpsSignIn } from './sign-in.js';

const ok: Run = { ok: true, out: '', err: '', missing: false };
const refused: Run = {
	ok: false,
	out: '',
	err: 'fatal: Authentication failed for https://dev.azure.com/contoso/Fabrikam/_git/app/\n',
	missing: false
};

// A sign-in whose token changes each time it is refreshed.
function tokens(): AzureDevOpsSignIn & { refreshed: number } {
	const state = {
		refreshed: 0,
		authorization: () => Promise.resolve(`Bearer token-${String(state.refreshed)}`),
		via: () => Promise.resolve('the Azure CLI'),
		refresh: () => {
			state.refreshed += 1;
			return Promise.resolve();
		}
	};
	return state;
}

function world() {
	const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
	ado.repository('app');
	return ado;
}

const noGit: AzureGitRunner = () => Promise.resolve(ok);

describe('AzureReposCodeHost', () => {
	let base: string | null = null;
	afterEach(async () => {
		if (base !== null) await rm(base, { recursive: true, force: true });
		base = null;
	});

	it('pushes to the repo factory.json names, its sign-in a header for Azure DevOps alone', async () => {
		const ran: { args: readonly string[]; cwd: string; extra: Env }[] = [];
		const git: AzureGitRunner = (args, cwd, extra) => {
			ran.push({ args, cwd, extra });
			return Promise.resolve(ok);
		};
		const api = new AzureDevOpsApi('contoso', tokens(), world().request);
		await new AzureReposCodeHost(
			api,
			{ project: 'Fabrikam Fiber', repo: 'Fiber App', referencesAs: 'work items' },
			git
		).push('/work/1-a', 'factory/1-a');
		expect(ran).toHaveLength(1);
		expect(ran[0]?.args).toEqual([
			'push',
			'-q',
			'https://dev.azure.com/contoso/Fabrikam%20Fiber/_git/Fiber%20App',
			'HEAD:refs/heads/factory/1-a'
		]);
		expect(ran[0]?.cwd).toBe('/work/1-a');
		expect(ran[0]?.extra).toEqual({
			GIT_TERMINAL_PROMPT: '0',
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: 'http.https://dev.azure.com/.extraHeader',
			GIT_CONFIG_VALUE_0: 'Authorization: Bearer token-0',
			GIT_CONFIG_KEY_1: 'credential.helper',
			GIT_CONFIG_VALUE_1: ''
		});
	});

	it('leaves the token in no git config and no remote, with real git', async () => {
		base = await mkdtemp(join(tmpdir(), 'nightjar-azure-repos-'));
		const config = join(base, 'gitconfig');
		await writeFile(config, '');
		const env = {
			...process.env,
			GIT_CONFIG_GLOBAL: config,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 'test@example.com'
		};
		const git = async (args: readonly string[], cwd: string) => {
			const got = await run('git', args, cwd, env);
			if (!got.ok) throw new Error(`git ${args.join(' ')} failed: ${got.err}`);
			return got.out.trim();
		};
		const origin = join(base, 'origin.git');
		const folder = join(base, 'work');
		await git(['init', '-q', '--bare', '-b', 'main', origin], base);
		await git(['init', '-q', '-b', 'main', folder], base);
		await git(['commit', '-q', '--allow-empty', '-m', 'one'], folder);
		const api = new AzureDevOpsApi('contoso', tokens(), world().request);
		const host = new AzureReposCodeHost(
			api,
			{ project: 'Fabrikam', repo: 'app', referencesAs: 'text' },
			(args, cwd, extra) => run('git', args, cwd, { ...env, ...extra }),
			origin
		);
		await host.push(folder, 'factory/1-a');
		expect(await git(['rev-parse', 'refs/heads/factory/1-a'], origin)).toBe(
			await git(['rev-parse', 'HEAD'], folder)
		);
		for (const file of [join(folder, '.git', 'config'), join(origin, 'config'), config]) {
			expect(await readFile(file, 'utf8')).not.toMatch(/token-|Authorization/);
		}
		expect(await git(['remote'], folder)).toBe('');
	});

	it('signs in afresh and pushes once more when a push is refused, then names why', async () => {
		const signIn = tokens();
		const headers: (string | undefined)[] = [];
		const git: AzureGitRunner = (_args, _cwd, extra) => {
			headers.push(extra.GIT_CONFIG_VALUE_0);
			return Promise.resolve(headers.length === 1 ? refused : ok);
		};
		const api = new AzureDevOpsApi('contoso', signIn, world().request);
		const host = new AzureReposCodeHost(
			api,
			{ project: 'Fabrikam', repo: 'app', referencesAs: 'text' },
			git
		);
		await host.push('/w', 'factory/1-a');
		expect(headers).toEqual(['Authorization: Bearer token-0', 'Authorization: Bearer token-1']);

		const never = new AzureReposCodeHost(
			api,
			{ project: 'Fabrikam', repo: 'app', referencesAs: 'text' },
			() => Promise.resolve(refused)
		);
		const fault = await never.push('/w', 'factory/1-a').catch((e: unknown) => e);
		expect(fault).toBeInstanceOf(AzureDevOpsFailure);
		expect((fault as Error).message).toBe(
			'git could not push factory/1-a to Azure Repos: fatal: Authentication failed for https://dev.azure.com/contoso/Fabrikam/_git/app/'
		);
	});

	it('cuts a body to what Azure Repos keeps, and never cuts the references', async () => {
		const ado = world();
		const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
		const host = new AzureReposCodeHost(
			api,
			{ project: 'Fabrikam', repo: 'app', referencesAs: 'text' },
			noGit
		);
		const long = `Nightjar built it.\n\n${'x'.repeat(5000)}`;
		const pull = await host.createDraft({
			title: 'A',
			head: 'factory/1-a',
			base: 'main',
			body: long
		});
		expect(ado.pullRequestAt(pull.id).description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
		expect(ado.pullRequestAt(pull.id).description).toMatch(/^Nightjar built it\./);
		await host.placeReferences(pull, [
			{ id: '7', text: '[issue 7](https://github.com/o/r/issues/7)' }
		]);
		await host.editBody(pull, long);
		const body = ado.pullRequestAt(pull.id).description;
		expect(body.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
		expect(body).toContain('Cut short');
		expect(body.endsWith(`${REFERENCES_MARK}\n- [issue 7](https://github.com/o/r/issues/7)`)).toBe(
			true
		);
	});

	it('links work items without naming them in the body, and gives the pull request page', async () => {
		const ado = world();
		const ticket = ado.workItem({ type: 'Product Backlog Item', title: 'A' });
		const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
		const host = new AzureReposCodeHost(
			api,
			{ project: 'Fabrikam', repo: 'app', referencesAs: 'work items' },
			noGit
		);
		const pull = await host.createDraft({
			title: 'A',
			head: 'factory/1-a',
			base: 'main',
			body: 'b'
		});
		expect(pull.url).toBe(
			`https://dev.azure.com/contoso/Fabrikam/_git/app/pullrequest/${String(pull.id)}`
		);
		await host.placeReferences(pull, [{ id: String(ticket), text: `#${String(ticket)}` }]);
		expect(ado.linkedWorkItems(pull.id)).toEqual([ticket]);
		expect(ado.pullRequestAt(pull.id).description).toBe('b');
	});

	it('reads the repo, and names it when Azure DevOps has none', async () => {
		const ado = world();
		const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
		const settings = { project: 'Fabrikam', referencesAs: 'text' as const };
		await new AzureReposCodeHost(api, { ...settings, repo: 'app' }, noGit).check();
		await expect(
			new AzureReposCodeHost(api, { ...settings, repo: 'gone' }, noGit).check()
		).rejects.toThrow(/could not read the repo gone: HTTP 404/);
	});
});

// A Code host over the fake, where opening a draft pushes its branch first.
function drafting() {
	const ado = world();
	const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
	const host = new AzureReposCodeHost(
		api,
		{ project: 'Fabrikam', repo: 'app', referencesAs: 'text' },
		noGit
	);
	let pushes = 0;
	const push = (branch: string) => {
		pushes += 1;
		const sha = String(pushes).padStart(40, 'a');
		ado.pushed(branch, sha);
		return sha;
	};
	const open = async (branch: string, body = `Body of ${branch}`) => {
		push(branch);
		return host.createDraft({ title: branch, head: branch, base: 'main', body });
	};
	const one = async (pull: Pull): Promise<NightjarDraft> => {
		const found = (await host.nightjarDrafts()).find((d) => d.pull.id === pull.id);
		if (found === undefined) throw new Error(`pull request ${String(pull.id)} is not listed`);
		return found;
	};
	return { ado, host, open, push, one };
}

const stamped = (line: string) => `2026-11-04T06:53:39.1234567Z ${line}`;

describe('AzureReposCodeHost.nightjarDrafts', () => {
	it("lists the open drafts on Nightjar's branches oldest first, each with its whole description and head", async () => {
		const { ado, host, open } = drafting();
		const marker = '<!-- nightjar-feature: 1 -->';
		const first = await open('factory/1-a', `${'Nightjar built it. '.repeat(30)}\n\n${marker}`);
		await open('person/fix-typo');
		const second = await open('factory/2-b');
		const ready = await open('factory/3-c');
		const abandoned = await open('factory/4-d');
		const completed = await open('factory/5-e');
		ado.markReady(ready.id);
		ado.abandon(abandoned.id);
		ado.complete(completed.id);
		const drafts = await host.nightjarDrafts();
		expect(drafts.map((d) => [d.pull, d.branch])).toEqual([
			[first, 'factory/1-a'],
			[second, 'factory/2-b']
		]);
		expect(drafts[0]?.body).toContain(marker);
		expect(drafts[0]?.headCommit).toBe(ado.headOf(first.id));
		expect(drafts[0]?.checks).toEqual({ pending: false, failed: [] });
		expect(drafts[0]?.personEngaged).toBe(false);
	});

	it('reads the pull requests a page at a time', async () => {
		const { host, open } = drafting();
		for (let n = 1; n <= 102; n += 1) await open(`factory/${String(n)}-x`);
		const drafts = await host.nightjarDrafts();
		expect(drafts).toHaveLength(102);
		expect(drafts.at(-1)?.branch).toBe('factory/102-x');
	});

	it('is pending while a build policy or a status runs on the head push', async () => {
		const { ado, open, push, one } = drafting();
		const pull = await open('factory/1-a');
		ado.policy(pull.id, { type: 'build', status: 'running', buildId: 1 });
		expect((await one(pull)).checks).toEqual({ pending: true, failed: [] });

		ado.clearChecks(pull.id);
		ado.policy(pull.id, { type: 'build', status: 'queued' });
		expect((await one(pull)).checks.pending).toBe(true);

		ado.clearChecks(pull.id);
		ado.status(pull.id, { name: 'deploy-preview', state: 'pending' });
		expect((await one(pull)).checks.pending).toBe(true);

		// a status on the push before the head says nothing of the head
		ado.status(pull.id, { name: 'lint', state: 'failed' });
		push('factory/1-a');
		expect((await one(pull)).checks).toEqual({ pending: false, failed: [] });

		ado.status(pull.id, { name: 'deploy-preview', state: 'pending', iteration: null });
		expect((await one(pull)).checks.pending).toBe(true);

		// nor does a build of an earlier push
		ado.clearChecks(pull.id);
		ado.policy(pull.id, { type: 'build', status: 'rejected', isExpired: true });
		expect((await one(pull)).checks).toEqual({ pending: true, failed: [] });
	});

	it("names a failed build's check, job, step and log tail, and a status's check alone", async () => {
		const { ado, open, one } = drafting();
		const pull = await open('factory/1-a');
		const log = Array.from({ length: 150 }, (_, i) => stamped(`line ${String(i + 1)}`)).join('\n');
		const buildId = ado.build([
			{ name: 'Lint', result: 'succeeded', steps: [{ name: 'Lint', result: 'succeeded' }] },
			{
				name: 'Test',
				result: 'failed',
				steps: [
					{ name: 'Checkout', result: 'succeeded', log: stamped('Syncing repository') },
					{ name: 'npm test', result: 'failed', log },
					{ name: 'Publish', result: 'canceled' }
				]
			}
		]);
		ado.policy(pull.id, { type: 'build', status: 'rejected', displayName: 'CI', buildId });
		ado.status(pull.id, { name: 'lint', state: 'failed', description: 'stale' });
		ado.status(pull.id, { name: 'lint', state: 'succeeded' });
		ado.status(pull.id, {
			genre: 'sonar',
			name: 'quality-gate',
			state: 'error',
			description: 'Coverage is 40%'
		});
		// a policy about reviewers is no Pull check
		ado.policy(pull.id, { type: 'reviewers', status: 'rejected' });
		const tail = Array.from({ length: 100 }, (_, i) => `line ${String(i + 51)}`).join('\n');
		expect((await one(pull)).checks).toEqual({
			pending: false,
			failed: [
				{ check: 'CI', job: 'Test', step: 'npm test', logTail: tail },
				{ check: 'sonar/quality-gate', job: '', step: '', logTail: 'Coverage is 40%' }
			]
		});
	});

	it('names a build by its pipeline, and keeps what the build or policy says when the log cannot be read', async () => {
		const { ado, open, one } = drafting();
		const pull = await open('factory/1-a');
		const buildId = ado.build([
			{
				name: 'Job',
				result: 'failed',
				steps: [{ name: 'Bash', result: 'failed', errors: ['Bash exited with code 1.'] }]
			}
		]);
		ado.policy(pull.id, { type: 'build', status: 'rejected', definition: 'app-ci', buildId });
		ado.policy(pull.id, {
			type: 'build',
			status: 'broken',
			definition: 'nightly',
			buildId: 404,
			preview: { jobName: 'Build', taskName: 'Restore', errors: ['No feed found.'] }
		});
		expect((await one(pull)).checks.failed).toEqual([
			{ check: 'app-ci', job: 'Job', step: 'Bash', logTail: 'Bash exited with code 1.' },
			{ check: 'nightly', job: 'Build', step: 'Restore', logTail: 'No feed found.' }
		]);
	});

	it('reads a failed build once', async () => {
		const { ado, host, open } = drafting();
		const pull = await open('factory/1-a');
		const buildId = ado.build([
			{ name: 'Test', result: 'failed', steps: [{ name: 'Test', result: 'failed', log: 'x' }] }
		]);
		ado.policy(pull.id, { type: 'build', status: 'rejected', buildId });
		await host.nightjarDrafts();
		await host.nightjarDrafts();
		expect(ado.asked.filter((a) => /\/_apis\/build\/builds\//.test(a.url))).toHaveLength(2);
	});

	it('counts a comment or vote by another identity as a person engaging, not its own nor what Azure Repos writes', async () => {
		const { ado, host, open, one } = drafting();
		const pull = await open('factory/1-a');
		await host.comment(pull, '**Nightjar review: approve**\n\nReads well.');
		ado.vote(pull.id, 'ann@contoso.com', 10);
		// a reviewer a policy added, who has not voted
		ado.vote(pull.id, 'bea@contoso.com', 0);
		ado.sayOnPull(pull.id, 'bea@contoso.com', 'Bea joined as a reviewer', { system: true });
		expect((await one(pull)).personEngaged).toBe(false);

		ado.vote(pull.id, 'bea@contoso.com', -5);
		expect((await one(pull)).personEngaged).toBe(true);

		const other = await open('factory/2-b');
		ado.sayOnPull(other.id, 'cal@contoso.com', 'Why this change?');
		expect((await one(other)).personEngaged).toBe(true);
		expect(ado.asked.filter((a) => a.url.includes('connectionData'))).toHaveLength(1);
	});

	it('stops when Azure DevOps cannot list the pull requests', async () => {
		const { ado, host, open } = drafting();
		await open('factory/1-a');
		ado.failNext(/pullrequests\?/, 503);
		await expect(host.nightjarDrafts()).rejects.toThrow(AzureDevOpsFailure);
	});
});
