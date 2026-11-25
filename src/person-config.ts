// ~/.config/nightjar/config.json: one person's own settings, which no repo's factory.json may set.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError, where } from './config.js';
import type { Env } from './git.js';
import { why } from './say.js';

export const DEFAULT_DAILY_USD = 60;

export const DEFAULT_POLL_SECONDS = 120;
export const MIN_POLL_SECONDS = 30;

export const DEFAULT_PARALLEL = 1;
export const MAX_PARALLEL = 8;

const PersonConfigSchema = z.strictObject({
	dailyUsd: z.number().positive('a dollar amount above 0').optional(),
	pollSeconds: z
		.number()
		.min(MIN_POLL_SECONDS, `at least ${String(MIN_POLL_SECONDS)} seconds`)
		.optional(),
	parallel: z
		.number()
		.int(`a whole number from 1 to ${String(MAX_PARALLEL)}`)
		.min(1, `a whole number from 1 to ${String(MAX_PARALLEL)}`)
		.max(MAX_PARALLEL, `a whole number from 1 to ${String(MAX_PARALLEL)}`)
		.optional(),
	assignee: z.string().regex(/\S/, 'a login on the Tracker').optional(),
	profile: z.string().regex(/\S/, 'a Claude profile: a name, a path, or default').optional()
});

export interface PersonConfig {
	// the estimated spend per local day at which a run pauses
	readonly dailyUsd: number;
	// how often --watch looks again when idle, in seconds
	readonly pollSeconds: number;
	// how many Slots a run holds: Features built at once, 1 to 8
	readonly parallel: number;
	// whose Features to build; left out, the person signed in to the Tracker
	readonly assignee?: string;
	// the Claude login of the sessions: a name, a path, or `default`; left out, the terminal's own
	readonly profile?: string;
}

export function personConfigPath(env: Env): string {
	const base = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config');
	return join(base, 'nightjar', 'config.json');
}

// How many Slots a run holds: `--parallel` wins over the person's `parallel`.
export const slotsFor = (flag: number | undefined, person: PersonConfig): number =>
	flag ?? person.parallel;

// The person's settings, the defaults where the file is missing or silent, or a ConfigError naming each wrong field.
export function loadPersonConfig(env: Env): PersonConfig {
	const path = personConfigPath(env);
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return {
			dailyUsd: DEFAULT_DAILY_USD,
			pollSeconds: DEFAULT_POLL_SECONDS,
			parallel: DEFAULT_PARALLEL
		};
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (fault) {
		throw new ConfigError(`${path} is not JSON: ${why(fault)}`);
	}
	const parsed = PersonConfigSchema.safeParse(value);
	if (!parsed.success) {
		throw new ConfigError(
			parsed.error.issues.map((i) => `${path}: ${where(i.path)}${i.message}`).join('\n')
		);
	}
	const {
		dailyUsd = DEFAULT_DAILY_USD,
		pollSeconds = DEFAULT_POLL_SECONDS,
		parallel = DEFAULT_PARALLEL,
		assignee,
		profile
	} = parsed.data;
	return {
		dailyUsd,
		pollSeconds,
		parallel,
		...(assignee === undefined ? {} : { assignee }),
		...(profile === undefined ? {} : { profile })
	};
}
