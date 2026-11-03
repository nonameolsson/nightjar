// The `nightjar` command.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, platformProblem, USAGE, type Args } from './args.js';
import { buildFeature, LIMITS, type Deps, type Setup } from './build.js';
import { runCheck } from './check.js';
import { checkMachine, Refusal, type Ready } from './checks.js';
import { codingAgent } from './coding-agent.js';
import type { AzureDevOpsRequest } from './azure-devops/index.js';
import type { GhRunner } from './github/api.js';
import type { Ask } from './ask.js';
import type { Prompter } from './prompter.js';
import { runDoctor } from './doctor.js';
import { runInitCommand } from './init.js';
import { runContractCommand } from './contract/command.js';
import { runCreateCommand } from './create.js';
import { ConfigError } from './config.js';
import type { Env } from './git.js';
import { fileSpend, ledgerPath } from './ledger.js';
import { claimPorts, portEnv } from './ports.js';
import { buildNamed, cannotClaim, handBack, queue, type QueueDeps } from './queue.js';
import { runSession } from './session.js';
import { runUiCommand } from './ui-command.js';
import { realSeams, startStale } from './stale.js';
import { startServe } from './serve.js';
import { StatusFile, statusPath, type Named } from './status.js';
import { openWorktree, worktreesFor } from './worktree.js';
import { say, why } from './say.js';
import { startLive } from './live.js';

// where this Nightjar is installed or checked out: src/ and dist/ both sit one level down
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

// package.json sits at PACKAGE_DIR from both src/ and dist/
function packageVersion(): string {
	const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
		version: string;
	};
	return pkg.version;
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

// The checks of a build stop at the first that fails, and the machine's findings are said in one line.
async function preflight(args: Args, host: Host): Promise<Ready> {
	const checked = await checkMachine({
		useApiKey: args.useApiKey,
		...(args.profile === undefined ? {} : { profile: args.profile }),
		env: host.env,
		cwd: host.cwd,
		failFast: true,
		...(host.request === undefined ? {} : { request: host.request }),
		...(host.gh === undefined ? {} : { gh: host.gh })
	});
	if (checked.refusal !== null) throw new Refusal(checked.refusal);
	const { ready, lines } = checked;
	const { adapters, me, assignee, person } = ready;
	say(`${adapters.repo}, as ${me}, on ${ready.login ?? 'ANTHROPIC_API_KEY'}`);
	// with the build ready, a line that failed is a Workflow's own
	for (const l of lines) {
		if (l.status === 'fail') say(`${l.name} cannot run: ${l.detail}`);
	}
	const found = lines.flatMap((l) => (l.summary === null ? [] : [l.summary]));
	say(`checked: ${found.join(', ')}`);
	if (assignee !== me) say(`building the Features assigned to ${assignee}`);
	if (person.dailyUsd !== LIMITS.dailyUsd) say(`daily limit $${String(person.dailyUsd)}`);
	return ready;
}

// What the command reads of the machine it runs on; a spec passes its own.
export interface Host {
	readonly platform: NodeJS.Platform;
	readonly env: Env;
	readonly cwd: string;
	// answers every Azure DevOps call; a spec passes a fake Azure DevOps
	readonly request?: AzureDevOpsRequest;
	// runs every `gh` call; a spec passes a fake GitHub
	readonly gh?: GhRunner;
	// where init's questions are put; standard input unless a spec passes its own
	readonly ask?: Ask;
	// select and multi-select prompts for init; a terminal gets them unless a spec passes its own
	readonly prompter?: Prompter;
	// ends `nightjar ui`; Ctrl-C or SIGTERM unless a spec passes its own
	readonly stop?: AbortSignal;
}

export async function runNightjar(
	argv: readonly string[],
	given: Partial<Host> = {}
): Promise<number> {
	const host: Host = {
		platform: process.platform,
		env: process.env,
		cwd: process.cwd(),
		...given
	};
	const unsupported = platformProblem(host.platform);
	if (unsupported !== null) {
		console.error(`nightjar: ${unsupported}`);
		return 2;
	}
	if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0] ?? '')) {
		console.log(USAGE);
		return 0;
	}
	if (argv.length === 1 && ['--version', '-v'].includes(argv[0] ?? '')) {
		console.log(packageVersion());
		return 0;
	}
	if (argv[0] === 'init') return runInitCommand(argv.slice(1), host);
	if (argv[0] === 'contract') return runContractCommand(argv.slice(1));
	if (argv[0] === 'create') return runCreateCommand(argv.slice(1));
	if (argv[0] === 'ui') return runUiCommand(argv.slice(1), host);
	const args = parseArgs(argv);
	if (typeof args === 'string') {
		console.error(`nightjar: ${args}\n\n${USAGE}`);
		return 2;
	}
	const env: Env = { ...host.env, GIT_TERMINAL_PROMPT: '0' };
	if (args.mode === 'doctor') {
		const { cwd, request, gh } = host;
		return runDoctor({
			useApiKey: args.useApiKey,
			...(args.profile === undefined ? {} : { profile: args.profile }),
			env,
			cwd,
			...(request ? { request } : {}),
			...(gh ? { gh } : {})
		});
	}
	let ready: Ready;
	try {
		ready = await preflight(args, { ...host, env });
	} catch (fault) {
		if (!(fault instanceof Refusal) && !(fault instanceof ConfigError)) throw fault;
		console.error(`nightjar: ${fault.message}`);
		return 2;
	}
	const { root, config, adapters } = ready;

	const spend = fileSpend(ledgerPath(root));
	const status = new StatusFile({
		path: statusPath(root),
		spend,
		now: () => new Date(),
		pid: process.pid,
		dailyUsd: ready.person.dailyUsd
	});
	// the reserved ports are held until the process ends, whatever ends it
	const claim = config.ports === undefined ? null : await claimPorts({ count: config.ports.count });
	if (config.ports !== undefined) {
		if (claim === null) {
			console.error(
				`nightjar: no ${String(config.ports.count)} free, unclaimed ports to reserve; stop another run or lower ports.count in factory.json.`
			);
			return 2;
		}
		process.once('exit', () => claim.release());
		say(`ports ${String(claim.port)} to ${String(claim.port + config.ports.count - 1)}`);
	}
	const stop = new AbortController();
	// on a terminal the block redraws in place and the lines the command says go to it and to .factory/nightjar.log
	const live = process.stdout.isTTY
		? startLive({ root, repo: adapters.repo, out: process.stdout, now: () => new Date() })
		: null;
	// the run's own lines: into the block on a terminal, else printed as say prints them
	const runSay = live?.say ?? say;
	const setup: Setup = {
		root,
		repo: adapters.repo,
		worktrees: worktreesFor(homedir(), root),
		baseBranch: ready.baseBranch,
		check: config.check,
		allowedCommands: config.allowedCommands,
		signals: config.signals,
		...(ready.rules === null ? {} : { rules: ready.rules }),
		...(config.plugins === undefined ? {} : { plugins: config.plugins }),
		defaults: { model: config.model, effort: config.effort },
		review: config.review,
		...(config.setup === undefined ? {} : { setupCommand: config.setup }),
		...(config.workflows === undefined ? {} : { workflows: config.workflows }),
		...(config.defaultWorkflow === undefined ? {} : { defaultWorkflow: config.defaultWorkflow }),
		brokenWorkflows: ready.workflowProblems,
		...(config.ports === undefined || claim === null
			? {}
			: { portEnv: portEnv(claim.port, config.ports.env) }),
		allowApiKey: args.useApiKey,
		env: ready.env,
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.effort === undefined ? {} : { effort: args.effort }),
		limits: { ...LIMITS, dailyUsd: ready.person.dailyUsd },
		signal: stop.signal
	};
	const deps: Deps = {
		tracker: adapters.tracker,
		codeHost: adapters.codeHost,
		codingAgent: codingAgent(setup, (req) => runSession(req)),
		runCheck: (command, cwd, env) => runCheck(command, cwd, env, config.gate ?? {}),
		runSetup: runCheck,
		serve: startServe,
		spend,
		openWorktree,
		now: () => new Date(),
		newId: () => randomUUID(),
		say: runSay,
		status
	};
	// the Feature being built, so a fault that escapes every catch can still hand it back
	let building: Named | null = null;
	const queueDeps: QueueDeps = {
		tracker: adapters.tracker,
		person: ready.assignee,
		build: async (feature) => {
			building = feature;
			try {
				return await buildFeature(deps, setup, feature.id);
			} finally {
				building = null;
			}
		},
		status,
		now: () => new Date(),
		say: runSay,
		sleep,
		signal: stop.signal,
		...(args.mode === 'watch' ? { newer: await startStale(realSeams(PACKAGE_DIR, ready.env)) } : {})
	};

	process.once('exit', () => status.doing({ kind: 'off' }));
	process.once('exit', () => live?.stop());
	// keep a Mac awake, so a long run is not put to sleep and a signing agent stays unlocked
	if (process.platform === 'darwin') {
		const awake = spawn('caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' });
		awake.on('error', () => undefined);
	}
	process.on('SIGINT', () => {
		if (stop.signal.aborted) process.exit(130);
		runSay(
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

	try {
		if (args.mode === 'feature' && args.feature !== undefined) {
			let refusal: string | null;
			try {
				refusal = await cannotClaim(queueDeps, args.feature);
			} catch (fault) {
				refusal = why(fault);
			}
			if (refusal !== null) {
				live?.stop();
				console.error(`nightjar: ${refusal}`);
				return 2;
			}
			let outcome;
			try {
				outcome = await buildNamed(queueDeps, args.feature);
			} catch (fault) {
				live?.stop();
				console.error(`nightjar: ${why(fault)}`);
				return 2;
			}
			return outcome?.kind === 'pull' || outcome?.kind === 'nothing' ? 0 : 1;
		}
		return await queue(queueDeps, args.mode === 'once');
	} finally {
		// the redraws would keep the process alive; the block ends on "stopped"
		status.doing({ kind: 'off' });
		live?.stop();
	}
}
