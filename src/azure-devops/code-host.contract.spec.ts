// Azure Repos against the Code host contract, over a fake Azure DevOps and real git pushing to a bare origin.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { run, type Env } from '../git.js';
import {
	codeHostContract,
	feedbackContract,
	nightjarDraftsContract,
	openPullsContract,
	type DraftsWorld,
	type Given,
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

// The statuses a service posts for each conclusion; a pass, a skip and a neutral one are not red.
const STATUS_STATES = {
	failure: 'failed',
	timed_out: 'error',
	success: 'succeeded',
	skipped: 'notApplicable',
	neutral: 'notSet'
} as const;

// A person on Azure DevOps is trusted when in the project's Contributors group.
const person = (ado: FakeAzureDevOps, author: string, trusted: boolean) =>
	ado.join(author, { contributor: trusted });

// Feedback as Azure Repos shows it. A check is a status, trusted when Azure Pipelines posts it. A comment is a thread, or a line comment. Azure Repos has two votes that are reviews: Waiting for author asks for changes, Rejected does not start a Feedback round by itself, so Rejected stands in for a review that only comments. An approval is a vote that is no feedback; the words that come with one are a comment.
function giveOnAzure(ado: FakeAzureDevOps, pull: Pull, given: Given): string {
	if (given.kind === 'check') {
		const id = ado.status(pull.id, {
			name: given.name,
			genre: given.trusted ? 'Azure Pipelines' : 'unknown-app',
			state: STATUS_STATES[given.conclusion],
			description: given.output
		});
		return `check:${String(id)}`;
	}
	person(ado, given.author, given.trusted);
	if (given.kind === 'comment') {
		const on = given.on ?? null;
		const said = ado.sayOnPull(pull.id, given.author, given.body, { on });
		return `comment:${String(said.thread)}.${String(said.comment)}`;
	}
	if (given.approval === true) {
		const thread = ado.vote(pull.id, given.author, 10);
		if (given.body === '') return `review:${String(thread)}`;
		const said = ado.sayOnPull(pull.id, given.author, given.body);
		return `comment:${String(said.thread)}.${String(said.comment)}`;
	}
	const vote = given.changes === true ? -5 : -10;
	return `review:${String(ado.vote(pull.id, given.author, vote, given.body))}`;
}

const threadOf = (id: string) => Number(/^comment:(\d+)\./.exec(id)?.[1]);

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
	const commit = async (message?: string) => {
		made += 1;
		await writeFile(join(folder, `${String(made)}.txt`), 'a change\n');
		await git(['add', '.'], folder);
		await git(['commit', '-q', '-m', message ?? `change ${String(made)}`], folder);
		return { folder, commit: await git(['rev-parse', 'HEAD'], folder) };
	};
	await commit();
	await git(['push', '-q', 'origin', 'main'], folder);

	// the commits HEAD holds that the base lacks, oldest first
	const ownCommits = async (cwd: string) => {
		const log = await git(['log', '--reverse', '--format=%H%x00%B%x1e', 'origin/main..HEAD'], cwd);
		return log
			.split('\x1e')
			.map((record) => record.trim())
			.filter((record) => record !== '')
			.map((record) => {
				const at = record.indexOf('\0');
				return { sha: record.slice(0, at), message: record.slice(at + 1).trim() };
			});
	};

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
			ado.pushed(ref[1] ?? '', await git(['rev-parse', 'HEAD'], cwd), await ownCommits(cwd));
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
				comments: ado.conversation(pull.id)
			});
		},
		bench: {
			give: (pull: Pull, given: Given) => Promise.resolve(giveOnAzure(ado, pull, given)),
			thread: (pull: Pull, id: string) => Promise.resolve(ado.repliesIn(pull.id, threadOf(id)))
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

describe('AzureReposCodeHost meets the feedback contract', { timeout: 30_000 }, () => {
	for (const c of feedbackContract) it(c.name, () => c.run(azureReposCodeHost('text')));
});

describe('AzureReposCodeHost meets the openPulls contract', { timeout: 30_000 }, () => {
	for (const c of openPullsContract) it(c.name, () => c.run(azureReposCodeHost('text')));
});
