// The `nightjar` command's arguments.
import type { Env } from './git.js';
import { MIN_POLL_SECONDS } from './person-config.js';

export const USAGE = `usage: nightjar <--watch | --once | FEATURE | doctor [FEATURE]> [--use-api-key] [--profile NAME] [--model M] [--effort LEVEL] [--poll SECONDS]

  --watch        build the Features assigned to you with the Go, oldest first, and look again every 2 minutes (pollSeconds in config.json)
  --poll SECONDS with --watch only: look again after this many seconds (at least 30), over config.json's pollSeconds
  --once         build the oldest Feature assigned to you with the Go, then exit
  FEATURE        build that Feature, by its id (42, #42, PROJ-123), now
  doctor         check this machine and list the Features it would build, building nothing (--dry-run is the old name)
  doctor FEATURE check that Feature's open Tickets against the Ticket contract, changing nothing; exits 1 when one fails
  --use-api-key  let the sessions bill ANTHROPIC_API_KEY instead of your Claude plan
  --profile NAME run the sessions as the Claude login in ~/.claude-NAME (a path is the folder itself, default is ~/.claude); over config.json's profile
  --model M      the model of every session, over a Ticket's own line and factory.json
  --effort LEVEL the effort of every session, over a Ticket's own line and factory.json
  --version, -v  print the installed version

       nightjar init [--yes] [--check CMD] ...   ask for the Tracker and Code host, write factory.json, create the Signal labels, check the logins; --yes asks nothing
       nightjar create [--dry-run] FILE   make a Feature and its Tickets on the Tracker from a Feature file
       nightjar ui [--port PORT]  serve a read-only page about this repo's builds on http://127.0.0.1:4545 (127.0.0.1 only), read from .factory/
       nightjar intake [--port PORT] [--host HOST]  take the webhooks of factory.json's Sources on http://127.0.0.1:4546/sources/NAME and make each Feature on the Tracker; it builds nothing
       nightjar contract MODULE   check a module's own Tracker or Code host against the contract suites`;

export const INTAKE_USAGE = `usage: nightjar intake [--port PORT] [--host HOST]

  --port PORT  the port to listen on, 4546 by default
  --host HOST  the address to listen on, 127.0.0.1 by default; set it for a reverse proxy on another machine`;

export const INTAKE_PORT = 4546;
export const INTAKE_HOST = '127.0.0.1';

export interface IntakeArgs {
	readonly port: number;
	readonly host: string;
}

// The address intake listens on, or the line that says what is wrong with the arguments.
export function parseIntakeArgs(argv: readonly string[]): IntakeArgs | string {
	let port = INTAKE_PORT;
	let host = INTAKE_HOST;
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i] ?? '';
		if (a !== '--port' && a !== '--host') return `unknown argument ${a}`;
		const value = argv[i + 1];
		if (value === undefined || value.startsWith('--') || value.trim() === '')
			return `${a} needs a value`;
		i += 1;
		if (a === '--host') host = value;
		else {
			const n = /^\d+$/.test(value) ? Number(value) : NaN;
			if (!(n <= 65535)) return `--port needs a number from 0 to 65535, not ${value}`;
			port = n;
		}
	}
	return { port, host };
}

export interface Args {
	readonly mode: 'watch' | 'once' | 'feature' | 'doctor';
	readonly feature?: string;
	readonly useApiKey: boolean;
	readonly profile?: string;
	readonly model?: string;
	readonly effort?: string;
	// seconds between --watch polls, over config.json's pollSeconds
	readonly poll?: number;
}

// The arguments, or the line that says what is wrong with them.
export function parseArgs(argv: readonly string[]): Args | string {
	// doctor with a Feature checks that Feature, so those two may be said together
	const chosen: { mode: 'watch' | 'once' | 'build' | null; doctor: boolean } = {
		mode: null,
		doctor: false
	};
	let feature: string | undefined;
	let useApiKey = false;
	let profile: string | undefined;
	let model: string | undefined;
	let effort: string | undefined;
	let poll: number | undefined;
	const pick = (m: 'watch' | 'once' | 'build' | 'doctor') => {
		const clash = 'choose one of --watch, --once, a Feature and doctor';
		if (m === 'doctor') {
			if (chosen.mode === 'watch' || chosen.mode === 'once') return clash;
			chosen.doctor = true;
			return null;
		}
		if (chosen.mode !== null || (m !== 'build' && chosen.doctor)) return clash;
		chosen.mode = m;
		return null;
	};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i] ?? '';
		let fault: string | null = null;
		if (a === '--watch') fault = pick('watch');
		else if (a === '--once') fault = pick('once');
		else if (a === 'doctor' || a === '--dry-run') fault = pick('doctor');
		else if (a === '--use-api-key') useApiKey = true;
		else if (a === '--model' || a === '--effort' || a === '--profile') {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) return `${a} needs a value`;
			if (a === '--model') model = value;
			else if (a === '--profile') profile = value;
			else effort = value;
			i += 1;
		} else if (a === '--poll') {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) return '--poll needs a value';
			if (!/^\d+$/.test(value) || Number(value) < MIN_POLL_SECONDS)
				return `--poll needs a whole number of seconds, at least ${String(MIN_POLL_SECONDS)}`;
			poll = Number(value);
			i += 1;
		} else if (/^#?[A-Za-z0-9][\w.-]*$/.test(a)) {
			fault = pick('build');
			feature = a.replace(/^#/, '');
		} else return `unknown argument ${a}`;
		if (fault) return fault;
	}
	const mode: Args['mode'] | null = chosen.doctor
		? 'doctor'
		: chosen.mode === 'build'
			? 'feature'
			: chosen.mode;
	if (mode === null) return 'say what to build';
	if (poll !== undefined && mode !== 'watch') return '--poll goes with --watch only';
	return {
		...(poll === undefined ? {} : { poll }),
		mode,
		useApiKey,
		...(feature === undefined ? {} : { feature }),
		...(profile === undefined ? {} : { profile }),
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort })
	};
}

export function apiKeyProblem(env: Env, useApiKey: boolean): string | null {
	if (useApiKey || !env.ANTHROPIC_API_KEY) return null;
	return 'ANTHROPIC_API_KEY is set, so every session would bill it per token instead of your Claude plan. Unset it, or pass --use-api-key if that is what you want.';
}

// WSL2 reports linux, so only a native Windows process is stopped.
export function platformProblem(platform: NodeJS.Platform): string | null {
	return platform === 'win32'
		? 'native Windows is not supported; Nightjar runs on macOS, Linux and WSL2.'
		: null;
}
