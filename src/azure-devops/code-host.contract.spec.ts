// Azure Repos against the Code host contract, over a fake Azure DevOps and real git pushing to a bare origin.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { run, type Env } from '../git.js';
import {
	codeHostContract,
	nightjarDraftsContract,
	type DraftsWorld,
	type Pull,
	type PullChecks
} from '../index.js';
import { AzureDevOpsApi } from './api.js';
import { AzureReposCodeHost, REFERENCES_MARK, type ReferencesAs } from './code-host.js';
import { FakeAzureDevOps } from './fake-azure-devops.js';

// A project and a repo name with spaces, as many have, so every address must encode them.
const PROJECT = 'Fabrikam Fiber';
const REPO = 'Fiber App';

// The references a person sees: the lines Nightjar placed in the body, and the linked work items.
function referencesShown(body: string, linked: readonly number[]): string[] {
	const at = body.indexOf(REFERENCES_MARK);
	const lines =
		at < 0
			? []
			: body
					.slice(at + REFERENCES_MARK.length)
					.split('\n')
					.map((l) => l.trim().replace(/^- /, ''))
					.filter((l) => l !== '');
	return [...lines, ...linked.map((id) => `#${String(id)}`)];
}

// each line stamped with its time, as Azure Pipelines writes a log
const stamp = (line: string) => `2026-11-04T06:53:39.1234567Z ${line}`;

// Each Pull check as Azure Repos reports it: one with a job as a failed build of a build validation policy, one without as a status.
function setChecks(ado: FakeAzureDevOps, pull: Pull, checks: PullChecks): void {
	ado.clearChecks(pull.id);
	if (checks.pending) ado.policy(pull.id, { type: 'build', status: 'running' });
	for (const f of checks.failed) {
		if (f.job === '') {
			ado.status(pull.id, { name: f.check, state: 'failed', description: f.logTail });
			continue;
		}
		const log = f.logTail.split('\n').map(stamp).join('\n');
		const buildId = ado.build([
			{
				name: f.job,
				result: 'failed',
				...(f.step === '' ? { log } : {}),
				steps: [
					{ name: 'Checkout', result: 'succeeded', log: stamp('Syncing repository') },
					...(f.step === '' ? [] : [{ name: f.step, result: 'failed', log }])
				]
			}
		]);
		ado.policy(pull.id, { type: 'build', status: 'rejected', displayName: f.check, buildId });
	}
}

function azureReposDrafts(ado: FakeAzureDevOps): DraftsWorld {
	const done = (act: () => void) => {
		act();
		return Promise.resolve();
	};
	return {
		checks: (pull, checks) => done(() => setChecks(ado, pull, checks)),
		engage: (pull) => done(() => ado.sayOnPull(pull.id, 'bea@contoso.com', 'Why this change?')),
		ready: (pull) => done(() => ado.markReady(pull.id)),
		closePull: (pull) => done(() => ado.abandon(pull.id))
	};
}

const azureReposCodeHost = (referencesAs: ReferencesAs) => async () => {
	const base = await mkdtemp(join(tmpdir(), 'nightjar-contract-'));
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
	await git(['clone', '-q', origin, folder], base);
	let made = 0;
	const commit = async () => {
		made += 1;
		await writeFile(join(folder, `${String(made)}.txt`), 'a change\n');
		await git(['add', '.'], folder);
		await git(['commit', '-q', '-m', `change ${String(made)}`], folder);
		return { folder, commit: await git(['rev-parse', 'HEAD'], folder) };
	};
	await commit();
	await git(['push', '-q', 'origin', 'main'], folder);

	const ado = new FakeAzureDevOps('contoso', PROJECT, 'ann@contoso.com');
	ado.repository(REPO);
	// the Tickets the contract references, as work items of the same organization
	for (const n of [1, 2, 3])
		ado.workItem({ type: 'Product Backlog Item', title: `Ticket ${String(n)}` });
	const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
	// Azure Repos learns of each push, so a pull request's head commit follows its branch
	const pushing = async (args: readonly string[], cwd: string, extra: Env) => {
		const got = await run('git', args, cwd, { ...env, ...extra });
		const ref = /^HEAD:refs\/heads\/(.+)$/.exec(args.at(-1) ?? '');
		if (got.ok && args[0] === 'push' && ref) {
			ado.pushed(ref[1] ?? '', await git(['rev-parse', 'HEAD'], cwd));
		}
		return got;
	};
	const codeHost = new AzureReposCodeHost(
		api,
		{ project: PROJECT, repo: REPO, referencesAs },
		pushing,
		origin
	);
	return {
		codeHost,
		drafts: azureReposDrafts(ado),
		base: 'main',
		commit,
		branch: async (name: string) => {
			const got = await run(
				'git',
				['rev-parse', '--verify', '-q', `refs/heads/${name}`],
				origin,
				env
			);
			return got.ok ? got.out.trim() : null;
		},
		pull: (pull: Pull) => {
			const shown = ado.pullRequestAt(pull.id);
			return Promise.resolve({
				title: shown.title,
				head: shown.sourceRefName.replace(/^refs\/heads\//, ''),
				base: shown.targetRefName.replace(/^refs\/heads\//, ''),
				body: shown.description,
				draft: shown.isDraft,
				references: referencesShown(shown.description, ado.linkedWorkItems(pull.id)),
				comments: shown.comments
			});
		},
		close: () => rm(base, { recursive: true, force: true })
	};
};

// real git on a busy machine is slow
describe('AzureReposCodeHost meets the Code host contract', { timeout: 30_000 }, () => {
	describe('linking work items of its own organization', () => {
		for (const c of codeHostContract) it(c.name, () => c.run(azureReposCodeHost('work items')));
	});

	describe('placing references from another Tracker in the body', () => {
		for (const c of codeHostContract) it(c.name, () => c.run(azureReposCodeHost('text')));
	});
});

describe('AzureReposCodeHost meets the nightjarDrafts contract', { timeout: 30_000 }, () => {
	for (const c of nightjarDraftsContract) it(c.name, () => c.run(azureReposCodeHost('text')));
});
