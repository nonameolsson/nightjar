// The `nightjar` command.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, platformProblem, USAGE, type Args } from './args.js';
import {
	buildFeature,
	fixPullChecks,
	LIMITS,
	pullFixLimits,
	type Asked,
	type Deps,
	type Setup
} from './build.js';
import { runCheck } from './check.js';
import { checkMachine, Refusal, type Ready } from './checks.js';
import { codingAgent } from './coding-agent.js';
import type { AzureDevOpsRequest } from './azure-devops/index.js';
import type { GhRunner } from './github/api.js';
import type { Ask } from './ask.js';
import type { Prompter } from './prompter.js';
import { runDoctor } from './doctor.js';
import { runFeatureDoctor } from './doctor-feature.js';
import { runInitCommand } from './init.js';
import { runContractCommand } from './contract/command.js';
import { runCreateCommand } from './create.js';
import { runIntakeCommand } from './intake.js';
import { ConfigError } from './config.js';
import type { Env } from './git.js';
import { fileSpend, ledgerPath } from './ledger.js';
import { fileLogbook } from './logbook.js';
import { leasePorts, type PortLease } from './ports.js';
import {
	buildNamed,
	cannotClaim,
	featureExit,
	feedbackPass,
	fixNamed,
	handBack,
	PAUSE_MS,
	publishPass,
	pullChecksPass,
	pullFixExit,
	queue,
	type PortEnv,
	type QueueDeps,
	type Say
} from './queue.js';
import { slotsFor } from './person-config.js';
import { heldSession, runSession, sessionExists, type Session } from './session.js';
import { runLogbookCommand } from './logbook-command.js';
import { runUiCommand } from './ui-command.js';
import { realSeams, startStale } from './stale.js';
import { startServe } from './serve.js';
import { StatusFile, statusPath, type Named } from './status.js';
import { openWorktree, worktreesFor } from './worktree.js';
import { say, why } from './say.js';
import type { Os } from './sandbox.js';
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
		os: host.os,
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
	// with the build ready, a line that failed is a Workflow's own; a Source's is for `nightjar intake`, which may run on another machine
	for (const l of lines) {
		if (l.status === 'fail' && l.source === undefined) say(`${l.name} cannot run: ${l.detail}`);
	}
	const found = lines.flatMap((l) => (l.summary === null ? [] : [l.summary]));
	say(`checked: ${found.join(', ')}`);
	if (assignee !== me) say(`building the Features assigned to ${assignee}`);
	if (person.dailyUsd !== LIMITS.dailyUsd) say(`daily limit $${String(person.dailyUsd)}`);
	return ready;
}

// What the command reads of the machine it runs on; a spec passes its own.
export interface Host {
	readonly os: Os;
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
	// ends `nightjar ui` and `nightjar intake`; Ctrl-C or SIGTERM unless a spec passes its own
	readonly stop?: AbortSignal;
}

export async function runNightjar(
	argv: readonly string[],
	given: Partial<Host> & Pick<Host, 'os'>
): Promise<number> {
	const host: Host = {
		env: process.env,
		cwd: process.cwd(),
		...given
	};
	const unsupported = platformProblem(host.os.platform);
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
	if (argv[0] === 'intake') return runIntakeCommand(argv.slice(1), host);
	if (argv[0] === 'logbook') return runLogbookCommand(argv.slice(1), host);
	const args = parseArgs(argv);
	if (typeof args === 'string') {
		console.error(`nightjar: ${args}\n\n${USAGE}`);
		return 2;
	}
	const env: Env = { ...host.env, GIT_TERMINAL_PROMPT: '0' };
	if (args.mode === 'doctor') {
		const { cwd, request, gh } = host;
		if (args.feature !== undefined) {
			return runFeatureDoctor({
				feature: args.feature,
				env,
				cwd,
				...(request ? { request } : {}),
				...(gh ? { gh } : {})
			});
		}
		return runDoctor({
			os: host.os,
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
	// Each Slot claims its own block of ports when it takes work and gives it back when the work ends. The blocks held now are also given back when the process ends, whatever ends it.
	const held = new Set<PortLease>();
	const reserved = config.ports;
	const claimBlock =
		reserved === undefined
			? undefined
			: async (): Promise<PortLease | null> => {
					const lease = await leasePorts({ count: reserved.count, names: reserved.env });
					if (lease === null) return null;
					const own: PortLease = {
						...lease,
						release: () => {
							held.delete(own);
							lease.release();
						}
					};
					held.add(own);
					return own;
				};
	process.once('exit', () => {
		for (const lease of [...held]) lease.release();
	});
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
		allowApiKey: args.useApiKey,
		env: ready.env,
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.effort === undefined ? {} : { effort: args.effort }),
		limits: {
			...LIMITS,
			dailyUsd: ready.person.dailyUsd,
			...pullFixLimits(config.pullChecks)
		},
		signal: stop.signal
	};
	// A Session's cap counts as spent against dailyUsd from its start until it ends, so the Sessions in the other Slots cannot together pass the day's limit; one that does not fit beside them waits until one of them ends.
	const session: Session = heldSession(
		(req) => runSession(req),
		spend,
		() => new Date(),
		setup.limits.dailyUsd
	);
	const deps: Deps = {
		tracker: adapters.tracker,
		codeHost: adapters.codeHost,
		codingAgent: codingAgent(setup, session),
		runCheck: (command, cwd, env) => runCheck(command, cwd, env, config.gate ?? {}),
		runSetup: runCheck,
		serve: startServe,
		spend,
		// written on a terminal or not, as the ledger is
		logbook: fileLogbook(root),
		openWorktree,
		now: () => new Date(),
		sleep,
		newId: () => randomUUID(),
		sessionExists: (id) => sessionExists(id, ready.env),
		say: runSay,
		status,
		// --watch tries a paused Feature again after PAUSE_MS, which its Status note gives as the time it is paused until
		...(args.mode === 'watch' ? { pauseMs: PAUSE_MS } : {})
	};
	// the Features being built, so a fault that escapes every catch can still hand them back
	const building = new Set<Named>();
	// a Slot's work speaks through the Slot's own say
	const slotDeps = (say: Say): Deps => (say === deps.say ? deps : { ...deps, say });
	// What one Slot's work runs on: its own say, and the block of ports the Slot claimed, which its Sessions and commands see. With no ports, the run's own setup and Coding agent.
	const workOf = (say: Say, portEnv?: PortEnv): { deps: Deps; setup: Setup } => {
		if (portEnv === undefined) return { deps: slotDeps(say), setup };
		const own: Setup = { ...setup, portEnv };
		return {
			deps: { ...slotDeps(say), codingAgent: codingAgent(own, session) },
			setup: own
		};
	};
	const pullChecks = pullChecksPass(config.pullChecks, adapters.codeHost, (red, say, portEnv) => {
		const work = workOf(say, portEnv);
		return fixPullChecks(work.deps, work.setup, red);
	});
	const publish = publishPass(config.publish, adapters.codeHost);
	// the build of one Feature, with the request for changes that started it when it has no Go
	const build = async (feature: Named, say: Say, portEnv?: PortEnv, started?: Asked) => {
		building.add(feature);
		try {
			const work = workOf(say, portEnv);
			return await buildFeature(work.deps, work.setup, feature.id, started);
		} finally {
			building.delete(feature);
		}
	};
	const feedback = feedbackPass(adapters.codeHost, (feature, asked, say, portEnv) =>
		build(feature, say, portEnv, { asked })
	);
	const queueDeps: QueueDeps = {
		tracker: adapters.tracker,
		person: ready.assignee,
		build: (feature, say, portEnv) => build(feature, say, portEnv),
		...(claimBlock === undefined ? {} : { claimPorts: claimBlock }),
		...(feedback === null ? {} : { feedback }),
		status,
		now: () => new Date(),
		say: runSay,
		sleep,
		signal: stop.signal,
		signals: config.signals,
		...(pullChecks === null ? {} : { pullChecks }),
		...(publish === null ? {} : { publish }),
		pollMs: (args.poll ?? ready.person.pollSeconds) * 1000,
		slots: slotsFor(args.parallel, ready.person),
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
		const now = [...building].map((f) => handBack(queueDeps, f, fault));
		void Promise.all(now).finally(() => process.exit(1));
	});

	try {
		if (args.mode === 'feature' && args.feature !== undefined) {
			// the one Feature holds one block of ports, as a Slot's work does
			const lease = (await claimBlock?.()) ?? null;
			if (reserved !== undefined) {
				if (lease === null) {
					live?.stop();
					console.error(
						`nightjar: no ${String(reserved.count)} free, unclaimed ports to reserve; stop another run or lower ports.count in factory.json.`
					);
					return 2;
				}
				runSay(`ports ${lease.ports}`);
			}
			try {
				// a Feature with a red draft is fixed, not built: it holds no Go by now
				const fixed = await fixNamed(queueDeps, args.feature, lease?.env);
				if (fixed !== null) return pullFixExit(fixed);
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
					outcome = await buildNamed(queueDeps, args.feature, lease?.env);
				} catch (fault) {
					live?.stop();
					console.error(`nightjar: ${why(fault)}`);
					return 2;
				}
				return featureExit(outcome);
			} finally {
				lease?.release();
			}
		}
		return await queue(queueDeps, args.mode === 'once');
	} finally {
		// the redraws would keep the process alive; the block ends on "stopped"
		status.doing({ kind: 'off' });
		live?.stop();
	}
}
