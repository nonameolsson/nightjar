// The `nightjar` command's arguments.
import type { Env } from './git.js';

export const USAGE = `usage: nightjar <--watch | --once | FEATURE | doctor> [--use-api-key] [--profile NAME] [--model M] [--effort LEVEL]

  --watch        build the Features assigned to you with the Go, oldest first, and look again every 2 minutes
  --once         build the oldest Feature assigned to you with the Go, then exit
  FEATURE        build that Feature, by its id (42, #42, PROJ-123), now
  doctor         check this machine and list the Features it would build, building nothing (--dry-run is the old name)
  --use-api-key  let the sessions bill ANTHROPIC_API_KEY instead of your Claude plan
  --profile NAME run the sessions as the Claude login in ~/.claude-NAME (a path is the folder itself, default is ~/.claude); over config.json's profile
  --model M      the model of every session, over a Ticket's own line and factory.json
  --effort LEVEL the effort of every session, over a Ticket's own line and factory.json

       nightjar init              ask for the Tracker and Code host, write factory.json, create the Signal labels, check the logins
       nightjar create [--dry-run] FILE   make a Feature and its Tickets on the Tracker from a Feature file
       nightjar contract MODULE   check a module's own Tracker or Code host against the contract suites`;

export interface Args {
	readonly mode: 'watch' | 'once' | 'feature' | 'doctor';
	readonly feature?: string;
	readonly useApiKey: boolean;
	readonly profile?: string;
	readonly model?: string;
	readonly effort?: string;
}

// The arguments, or the line that says what is wrong with them.
export function parseArgs(argv: readonly string[]): Args | string {
	const chosen: { mode: Args['mode'] | null } = { mode: null };
	let feature: string | undefined;
	let useApiKey = false;
	let profile: string | undefined;
	let model: string | undefined;
	let effort: string | undefined;
	const pick = (m: Args['mode']) => {
		if (chosen.mode !== null && chosen.mode !== m)
			return 'choose one of --watch, --once, a Feature and doctor';
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
		} else if (/^#?[A-Za-z0-9][\w.-]*$/.test(a)) {
			fault = pick('feature');
			feature = a.replace(/^#/, '');
		} else return `unknown argument ${a}`;
		if (fault) return fault;
	}
	const { mode } = chosen;
	if (mode === null) return 'say what to build';
	return {
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
