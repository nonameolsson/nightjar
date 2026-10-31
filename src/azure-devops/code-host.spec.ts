import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
			{ id: 7, text: '[issue 7](https://github.com/o/r/issues/7)' }
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
		await host.placeReferences(pull, [{ id: ticket, text: `#${String(ticket)}` }]);
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
