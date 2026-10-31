// The `nightjar` command: checks this machine and the repo's factory.json, then builds the Features
// assigned to the person with the Go, with nobody at the keyboard.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { makeAdapters, type Adapters } from './adapters.js';
import { apiKeyProblem, parseArgs, USAGE, type Args } from './args.js';
import { buildFeature, ledgerPath, LIMITS, type Deps, type Setup } from './build.js';
import { runCheck } from './check.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { firstLine, run, type Env } from './git.js';
import { buildOne, dryRun, handBack, queue, type QueueDeps } from './queue.js';
import { runSession } from './session.js';
import { StatusBoard, statusPath } from './status.js';
import { defaultBranch, signing, worktreesFor } from './worktree.js';

const say = (line: string) => console.log(`nightjar: ${line}`);

// A reason Nightjar will not start on this machine, said as it is.
class Refusal extends Error {}

async function need(command: string, args: readonly string[], cwd: string, env: Env, what: string) {
	const got = await run(command, args, cwd, env);
	if (got.missing) throw new Refusal(`${command} is not on the PATH.`);
	if (!got.ok) throw new Refusal(`${what}: ${firstLine(got.err) || firstLine(got.out)}`);
	return got.out.trim();
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((done) => {
		const timer = setTimeout(done, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				done();
			},
			{ once: true }
		);
	});

interface Ready {
	readonly root: string;
	readonly config: Config;
	readonly adapters: Adapters;
	readonly me: string;
	readonly baseBranch: string;
}

async function preflight(args: Args, env: Env): Promise<Ready> {
	const keyProblem = apiKeyProblem(env, args.useApiKey);
	if (keyProblem) throw new Refusal(keyProblem);
	if (Number(process.versions.node.split('.')[0]) < 24) {
		throw new Refusal(`Node 24 or later is needed, and this is ${process.versions.node}.`);
	}
	const top = ['rev-parse', '--show-toplevel'];
	const root = await need('git', top, process.cwd(), env, 'not inside a git checkout');
	const config = loadConfig(root);
	const adapters = await makeAdapters(config, root, env);
	const me = await adapters.tracker.me();
	const claude = await need('claude', ['--version'], root, env, 'claude does not start');
	const signs = await signing(root, env);
	if (signs === 'fails') {
		throw new Refusal('git cannot sign a commit; unlock your signing key and run again.');
	}
	const baseBranch = (await defaultBranch(root, env)) ?? 'main';
	say(
		`${adapters.repo}, as ${me}, on ${args.useApiKey ? 'ANTHROPIC_API_KEY' : 'your Claude login'}`
	);
	const key = args.useApiKey ? 'ANTHROPIC_API_KEY chosen' : 'no ANTHROPIC_API_KEY';
	const sign = signs === 'signs' ? 'git signs commits' : 'commits unsigned';
	say(
		`checked: ${key}, Node ${process.versions.node}, factory.json, ${adapters.checked(me)}, claude ${claude}, ${sign}`
	);
	return { root, config, adapters, me, baseBranch };
}

export async function runNightjar(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	if (typeof args === 'string') {
		console.error(`nightjar: ${args}\n\n${USAGE}`);
		return 2;
	}
	const env: Env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
	let ready: Ready;
	try {
		ready = await preflight(args, env);
	} catch (fault) {
		if (!(fault instanceof Refusal) && !(fault instanceof ConfigError)) throw fault;
		console.error(`nightjar: ${fault.message}`);
		return 2;
	}
	const { root, config, adapters } = ready;

	const status = new StatusBoard({
		path: statusPath(root),
		ledger: ledgerPath(root),
		now: () => new Date(),
		pid: process.pid,
		dailyUsd: LIMITS.dailyUsd
	});
	const stop = new AbortController();
	const deps: Deps = {
		tracker: adapters.tracker,
		codeHost: adapters.codeHost,
		session: (req) => runSession(req),
		runCheck: (command, cwd) => runCheck(command, cwd, env),
		now: () => new Date(),
		newId: () => randomUUID(),
		say,
		status
	};
	const setup: Setup = {
		root,
		repo: adapters.repo,
		worktrees: worktreesFor(homedir(), root),
		baseBranch: ready.baseBranch,
		check: config.check,
		allowedCommands: config.allowedCommands,
		allowApiKey: args.useApiKey,
		env,
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.effort === undefined ? {} : { effort: args.effort }),
		limits: LIMITS,
		signal: stop.signal
	};
	// the Feature being built, so a fault that escapes every catch can still hand it back
	let building: number | null = null;
	const queueDeps: QueueDeps = {
		tracker: adapters.tracker,
		person: ready.me,
		build: async (id) => {
			building = id;
			try {
				return await buildFeature(deps, setup, id);
			} finally {
				building = null;
			}
		},
		status,
		now: () => new Date(),
		say,
		sleep,
		signal: stop.signal
	};

	if (args.mode === 'dry-run') {
		await dryRun(queueDeps);
		return 0;
	}

	process.once('exit', () => status.doing({ kind: 'off' }));
	// keep a Mac awake, so a long run is not put to sleep and a signing agent stays unlocked
	if (process.platform === 'darwin') {
		const awake = spawn('caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' });
		awake.on('error', () => undefined);
	}
	process.on('SIGINT', () => {
		if (stop.signal.aborted) process.exit(130);
		say(
			'stopping: the running session ends and its Ticket goes back; Ctrl-C again to quit at once'
		);
		stop.abort();
	});
	process.once('SIGTERM', () => stop.abort());
	process.once('uncaughtException', (fault) => {
		const now = building;
		void (now === null ? Promise.resolve() : handBack(queueDeps, now, fault)).finally(() =>
			process.exit(1)
		);
	});

	if (args.mode === 'feature' && args.feature !== undefined) {
		const outcome = await buildOne(queueDeps, args.feature);
		return outcome?.kind === 'pull' || outcome?.kind === 'nothing' ? 0 : 1;
	}
	return queue(queueDeps, args.mode === 'once');
}
