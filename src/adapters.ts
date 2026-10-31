// The Tracker and Code host factory.json names, built over this machine's gh and git.
import { codeHostFromModule, trackerFromModule } from './adapter-module.js';
import type { CodeHost } from './code-host.js';
import { ConfigError, type Config } from './config.js';
import { run, type Env } from './git.js';
import { ghRunner, repoFromRemote } from './github/api.js';
import { GitHubCodeHost } from './github/code-host.js';
import { GitHubTracker } from './github/tracker.js';
import type { Tracker } from './tracker.js';

export interface Adapters {
	readonly tracker: Tracker;
	readonly codeHost: CodeHost;
	// what the ledger names the repo by
	readonly repo: string;
	// how the preflight line names the Tracker it reached, as `person`
	readonly checked: (person: string) => string;
}

export async function makeAdapters(config: Config, root: string, env: Env): Promise<Adapters> {
	let origin: string | null | undefined;
	const fromOrigin = async (field: string) => {
		if (origin === undefined) {
			const got = await run('git', ['remote', 'get-url', 'origin'], root, env);
			origin = got.ok ? repoFromRemote(got.out) : null;
		}
		if (origin === null) {
			throw new ConfigError(
				`origin is not a GitHub repo; set ${field} to owner/name in factory.json`
			);
		}
		return origin;
	};
	const gh = ghRunner(root, env);
	const git = (args: readonly string[], cwd: string) => run('git', args, cwd, env);

	const context = {
		root,
		signals: config.signals,
		...(config.trusted === undefined ? {} : { trusted: config.trusted })
	};
	let tracker: Tracker;
	let checked: (person: string) => string;
	if (config.tracker.type === 'module') {
		const { path } = config.tracker;
		tracker = await trackerFromModule(config.tracker, context);
		checked = (person) => `${path} as ${person}`;
	} else {
		const trackerRepo = config.tracker.repo ?? (await fromOrigin('tracker.repo'));
		tracker = new GitHubTracker(trackerRepo, gh, config.signals, config.trusted);
		checked = (person) => `gh as ${person} on ${trackerRepo}`;
	}
	let codeHost: CodeHost;
	let repo: string;
	if (config.codeHost.type === 'module') {
		codeHost = await codeHostFromModule(config.codeHost, context);
		repo = config.codeHost.path;
	} else {
		repo = config.codeHost.repo ?? (await fromOrigin('codeHost.repo'));
		codeHost = new GitHubCodeHost(repo, gh, git);
	}
	return { tracker, codeHost, repo, checked };
}
