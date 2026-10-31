// The GitHub adapters against the contract suites, over a fake GitHub: no spec here reaches the network.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { run } from '../git.js';
import {
	DEFAULT_SIGNAL_NAMES,
	GitHubCodeHost,
	GitHubTracker,
	codeHostContract,
	trackerContract,
	type Pull,
	type SignalNames,
	type TrackerWorld
} from '../index.js';
import { FakeGitHub } from './fake-github.js';

// Signal names and a trusted list as a repo's factory.json may set them.
const CONFIGURED: SignalNames = {
	go: 'build-this',
	ready: 'agent-may-build',
	working: 'agent-on-it',
	needsInfo: 'agent-asks',
	human: 'for-a-person'
};

// With a trusted list every author gets write access, so only the list can make the world's trust.
const gitHubTracker =
	(names: SignalNames, trust: 'write access' | 'trusted list') => (world: TrackerWorld) => {
		const { github, id } = gitHubWorld(world, names);
		const list = trust === 'trusted list' ? world.trusted : undefined;
		if (list) {
			for (const item of world.items) {
				for (const c of item.comments ?? []) github.grant(c.author, 'write');
			}
			github.grant(world.person, 'write');
		} else {
			for (const person of world.trusted) github.grant(person, 'write');
		}
		return Promise.resolve({ tracker: new GitHubTracker('o/r', github.gh, names, list), id });
	};

function gitHubWorld(world: TrackerWorld, names: SignalNames) {
	const github = new FakeGitHub('o/r', world.person);
	const numbers = new Map<string, number>();
	const id = (key: string) => {
		const found = numbers.get(key);
		if (found === undefined) throw new Error(`the world has no item ${key}`);
		return found;
	};
	for (const item of world.items) {
		numbers.set(
			item.key,
			github.issue({
				title: item.title,
				body: item.body ?? null,
				state: item.open === false ? 'closed' : 'open',
				labels: (item.signals ?? []).map((s) => names[s]),
				assignees: item.assignees ?? []
			})
		);
	}
	for (const item of world.items) {
		for (const child of item.children ?? []) github.addSubIssue(id(item.key), id(child));
		for (const blocker of item.blockedBy ?? []) github.block(id(item.key), id(blocker));
		for (const c of item.comments ?? []) github.say(id(item.key), c.author, c.body);
	}
	return { github, id };
}

// GitHub links a pull request to each issue named after one of its closing keywords.
const CLOSING = /^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(\S+)\s*$/gim;

// Real git pushes to a bare origin in a temporary folder; the pull requests live in the fake GitHub.
async function gitHubCodeHost() {
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

	const github = new FakeGitHub('o/r', 'ann');
	return {
		codeHost: new GitHubCodeHost('o/r', github.gh, (args, cwd) => run('git', args, cwd, env)),
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
			const shown = github.pullAt(pull.id);
			return Promise.resolve({
				...shown,
				references: [...shown.body.matchAll(CLOSING)].map((m) => m[1] ?? ''),
				comments: github.said(pull.id)
			});
		},
		close: () => rm(base, { recursive: true, force: true })
	};
}

describe('GitHubTracker meets the Tracker contract', () => {
	describe('with the default Signal names and write access as trust', () => {
		const harness = gitHubTracker(DEFAULT_SIGNAL_NAMES, 'write access');
		for (const c of trackerContract) it(c.name, () => c.run(harness));
	});

	describe("with factory.json's own Signal names and trusted list", () => {
		const harness = gitHubTracker(CONFIGURED, 'trusted list');
		for (const c of trackerContract) it(c.name, () => c.run(harness));
	});
});

// real git on a busy machine is slow
describe('GitHubCodeHost meets the Code host contract', { timeout: 30_000 }, () => {
	for (const c of codeHostContract) it(c.name, () => c.run(gitHubCodeHost));
});
