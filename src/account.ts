// Which Claude login the sessions use: the environment a profile gives them, and the account `claude auth status --json` names.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from './git.js';

// The sessions' environment under `profile`: its config folder, and no token, which would win over that folder.
export function profileEnv(profile: string | undefined, env: Env): Env {
	if (profile === undefined) return env;
	const { CLAUDE_CONFIG_DIR: _dir, CLAUDE_CODE_OAUTH_TOKEN: _token, ...rest } = env;
	if (profile === 'default') return rest;
	const home = env.HOME ?? homedir();
	let folder = join(home, `.claude-${profile}`);
	// a value with a slash is the folder itself; `~/` is the home folder
	if (profile.startsWith('~/')) folder = join(home, profile.slice(2));
	else if (profile.includes('/')) folder = profile;
	return { ...rest, CLAUDE_CONFIG_DIR: folder };
}

export interface Account {
	readonly loggedIn: boolean;
	readonly email?: string;
	readonly organization?: string;
	readonly plan?: string;
	readonly method?: string;
	readonly folder?: string;
}

const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

// The account in `claude auth status --json`, which has spelled its fields differently across versions; null when it is not JSON.
export function parseAccount(json: string): Account | null {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const f = value as Record<string, unknown>;
	const fields = {
		email: text(f.email) ?? text(f.emailAddress),
		organization: text(f.orgName) ?? text(f.organizationName),
		plan: text(f.subscriptionType),
		method: text(f.authMethod),
		folder: text(f.configDirectory)
	};
	return {
		loggedIn: f.loggedIn === true,
		...Object.fromEntries(Object.entries(fields).filter((e) => e[1] !== undefined))
	};
}

// The account as one line, leaving out what the claude did not say.
export function accountLine(a: Account): string {
	return [
		a.email,
		a.organization,
		a.plan === undefined ? undefined : `${a.plan} plan`,
		a.method === undefined ? undefined : `${a.method} login`,
		a.folder === undefined ? undefined : `config ${a.folder}`
	]
		.filter((part) => part !== undefined)
		.join(', ');
}
