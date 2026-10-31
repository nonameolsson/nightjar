// The `nightjar` command's arguments.
import type { Env } from './git.js';

export const USAGE = `usage: nightjar <--watch | --once | FEATURE | --dry-run> [--use-api-key] [--model M] [--effort LEVEL]

  --watch        build the Features assigned to you with the Go, oldest first, and look again every 2 minutes
  --once         build the oldest Feature assigned to you with the Go, then exit
  FEATURE        build that Feature, by its number, now
  --dry-run      check this machine and list the Features it would build, building nothing
  --use-api-key  let the sessions bill ANTHROPIC_API_KEY instead of your Claude plan
  --model M      the model of every session, over a Ticket's own line and factory.json
  --effort LEVEL the effort of every session, over a Ticket's own line and factory.json

       nightjar create [--dry-run] FILE   make a Feature and its Tickets on the Tracker from a Feature file
       nightjar contract MODULE   check a module's own Tracker or Code host against the contract suites`;

export interface Args {
	readonly mode: 'watch' | 'once' | 'feature' | 'dry-run';
	readonly feature?: number;
	readonly useApiKey: boolean;
	readonly model?: string;
	readonly effort?: string;
}

// The arguments, or the line that says what is wrong with them.
export function parseArgs(argv: readonly string[]): Args | string {
	const chosen: { mode: Args['mode'] | null } = { mode: null };
	let feature: number | undefined;
	let useApiKey = false;
	let model: string | undefined;
	let effort: string | undefined;
	const pick = (m: Args['mode']) => {
		if (chosen.mode !== null && chosen.mode !== m)
			return 'choose one of --watch, --once, a Feature and --dry-run';
		chosen.mode = m;
		return null;
	};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i] ?? '';
		let fault: string | null = null;
		if (a === '--watch') fault = pick('watch');
		else if (a === '--once') fault = pick('once');
		else if (a === '--dry-run') fault = pick('dry-run');
		else if (a === '--use-api-key') useApiKey = true;
		else if (a === '--model' || a === '--effort') {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) return `${a} needs a value`;
			if (a === '--model') model = value;
			else effort = value;
			i += 1;
		} else if (/^#?\d+$/.test(a)) {
			fault = pick('feature');
			feature = Number(a.replace('#', ''));
		} else return `unknown argument ${a}`;
		if (fault) return fault;
	}
	const { mode } = chosen;
	if (mode === null) return 'say what to build';
	return {
		mode,
		useApiKey,
		...(feature === undefined ? {} : { feature }),
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort })
	};
}

export function apiKeyProblem(env: Env, useApiKey: boolean): string | null {
	if (useApiKey || !env.ANTHROPIC_API_KEY) return null;
	return 'ANTHROPIC_API_KEY is set, so every session would bill it per token instead of your Claude plan. Unset it, or pass --use-api-key if that is what you want.';
}
