// The `nightjar` command: checks this machine and the repo's factory.json, then builds the Features
// assigned to the person with the Go, with nobody at the keyboard.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { parseArgs, platformProblem, USAGE, type Args } from './args.js';
import { buildFeature, ledgerPath, LIMITS, type Deps, type Setup } from './build.js';
import { runCheck } from './check.js';
import { checkMachine, Refusal, type Ready } from './checks.js';
import type { AzureDevOpsRequest } from './azure-devops/index.js';
import type { Ask } from './ask.js';
import { runDoctor } from './doctor.js';
import { runInitCommand } from './init.js';
import { runContractCommand } from './contract/command.js';
import { runCreateCommand } from './create.js';
import { ConfigError } from './config.js';
import type { Env } from './git.js';
import { claimPorts, portEnv } from './ports.js';
import { buildOne, cannotClaim, handBack, queue, type QueueDeps } from './queue.js';
import { runSession } from './session.js';
import { StatusBoard, statusPath } from './status.js';
import { worktreesFor } from './worktree.js';
import { say, why } from './say.js';

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
		env: host.env,
		cwd: host.cwd,
		failFast: true,
		...(host.request === undefined ? {} : { request: host.request })
	});
	const failed = checked.lines.find((l) => l.status === 'fail');
	if (failed !== undefined) throw new Refusal(failed.detail);
	if (checked.ready === null) throw new Refusal('the checks did not finish');
	const { adapters, me } = checked.ready;
	say(
		`${adapters.repo}, as ${me}, on ${args.useApiKey ? 'ANTHROPIC_API_KEY' : 'your Claude login'}`
	);
	const found = checked.lines.flatMap((l) => (l.summary === null ? [] : [l.summary]));
	say(`checked: ${found.join(', ')}`);
	const { assignee, person } = checked.ready;
	if (assignee !== me) say(`building the Features assigned to ${assignee}`);
	if (person.dailyUsd !== LIMITS.dailyUsd) say(`daily limit $${String(person.dailyUsd)}`);
	return checked.ready;
}

// What the command reads of the machine it runs on; a spec passes its own.
export interface Host {
	readonly platform: NodeJS.Platform;
	readonly env: Env;
	readonly cwd: string;
	// answers every Azure DevOps call; a spec passes a fake Azure DevOps
	readonly request?: AzureDevOpsRequest;
	// where init's questions are put; standard input unless a spec passes its own
	readonly ask?: Ask;
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
	if (argv[0] === 'init') return runInitCommand(argv.slice(1), host);
	if (argv[0] === 'contract') return runContractCommand(argv.slice(1));
	if (argv[0] === 'create') return runCreateCommand(argv.slice(1));
	const args = parseArgs(argv);
	if (typeof args === 'string') {
		console.error(`nightjar: ${args}\n\n${USAGE}`);
		return 2;
	}
	const env: Env = { ...host.env, GIT_TERMINAL_PROMPT: '0' };
	if (args.mode === 'doctor') {
		const { cwd, request } = host;
		return runDoctor({ useApiKey: args.useApiKey, env, cwd, ...(request ? { request } : {}) });
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

	const status = new StatusBoard({
		path: statusPath(root),
		ledger: ledgerPath(root),
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
	const deps: Deps = {
		tracker: adapters.tracker,
		codeHost: adapters.codeHost,
		session: (req) => runSession(req),
		runCheck,
		runSetup: runCheck,
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
		...(ready.rules === null ? {} : { rules: ready.rules }),
		defaults: { model: config.model, effort: config.effort },
		review: config.review,
		...(config.setup === undefined ? {} : { setupCommand: config.setup }),
		...(config.ports === undefined || claim === null
			? {}
			: { portEnv: portEnv(claim.port, config.ports.env) }),
		allowApiKey: args.useApiKey,
		env,
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.effort === undefined ? {} : { effort: args.effort }),
		limits: { ...LIMITS, dailyUsd: ready.person.dailyUsd },
		signal: stop.signal
	};
	// the Feature being built, so a fault that escapes every catch can still hand it back
	let building: string | null = null;
	const queueDeps: QueueDeps = {
		tracker: adapters.tracker,
		person: ready.assignee,
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
		let refusal: string | null;
		try {
			refusal = await cannotClaim(queueDeps, args.feature);
		} catch (fault) {
			refusal = why(fault);
		}
		if (refusal !== null) {
			console.error(`nightjar: ${refusal}`);
			return 2;
		}
		const outcome = await buildOne(queueDeps, args.feature);
		return outcome?.kind === 'pull' || outcome?.kind === 'nothing' ? 0 : 1;
	}
	return queue(queueDeps, args.mode === 'once');
}
