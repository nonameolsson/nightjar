// ~/.config/nightjar/config.json: one person's own settings, which no repo's factory.json may set.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError, where } from './config.js';
import type { Env } from './git.js';
import { why } from './say.js';

export const DEFAULT_DAILY_USD = 60;

const PersonConfigSchema = z.strictObject({
	dailyUsd: z.number().positive('a dollar amount above 0').optional(),
	assignee: z.string().regex(/\S/, 'a login on the Tracker').optional(),
	profile: z.string().regex(/\S/, 'a Claude profile: a name, a path, or default').optional()
});

export interface PersonConfig {
	// the estimated spend per local day at which a run pauses
	readonly dailyUsd: number;
	// whose Features to build; left out, the person signed in to the Tracker
	readonly assignee?: string;
	// the Claude login of the sessions: a name, a path, or `default`; left out, the terminal's own
	readonly profile?: string;
}

export function personConfigPath(env: Env): string {
	const base = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config');
	return join(base, 'nightjar', 'config.json');
}

// The person's settings, the defaults where the file is missing or silent, or a ConfigError naming each wrong field.
export function loadPersonConfig(env: Env): PersonConfig {
	const path = personConfigPath(env);
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return { dailyUsd: DEFAULT_DAILY_USD };
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
	const { dailyUsd = DEFAULT_DAILY_USD, assignee, profile } = parsed.data;
	return {
		dailyUsd,
		...(assignee === undefined ? {} : { assignee }),
		...(profile === undefined ? {} : { profile })
	};
}
