// Whether a newer Nightjar than the one this run started with is installed or published; a read only, and a fault is "no".
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type Env, type Run } from './git.js';

const TIMEOUT_MS = 30_000;

export const PACKAGE_NAME = '@nonameolsson/nightjar';

// The newer version or commit, or null; never throws.
export type Newer = () => Promise<string | null>;

export interface StaleSeams {
	// the directory Nightjar runs from
	readonly packageDir: string;
	readonly env: Env;
	// a linked checkout (built from source) rather than an installed package
	readonly isCheckout: () => boolean;
	readonly installedVersion: () => string | null;
	// how long one git or npm call may take; a watch never waits longer on the network
	readonly timeoutMs?: number;
	readonly run: (command: string, args: readonly string[], cwd: string, env: Env) => Promise<Run>;
}

export const realSeams = (packageDir: string, env: Env): StaleSeams => ({
	packageDir,
	env,
	isCheckout: () => existsSync(join(packageDir, '.git')),
	installedVersion: () => {
		try {
			const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
				version?: unknown;
			};
			return typeof pkg.version === 'string' ? pkg.version : null;
		} catch {
			return null;
		}
	},
	run
});

const parts = (version: string) => version.split('-')[0]?.split('.').map(Number) ?? [];

// Plain release versions only; a malformed one is never newer.
function isNewer(candidate: string, than: string): boolean {
	const a = parts(candidate);
	const b = parts(than);
	if ([...a, ...b].some(Number.isNaN)) return false;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

async function out(seams: StaleSeams, command: string, args: string[]): Promise<string | null> {
	let timer: NodeJS.Timeout | undefined;
	const gaveUp = new Promise<null>((done) => {
		timer = setTimeout(() => done(null), seams.timeoutMs ?? TIMEOUT_MS);
	});
	try {
		const got = await Promise.race([seams.run(command, args, seams.packageDir, seams.env), gaveUp]);
		return got?.ok === true ? got.out.trim() : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// Remembers what this run started with and returns the check to make while idle.
export async function startStale(seams: StaleSeams): Promise<Newer> {
	if (seams.isCheckout()) {
		const started = await out(seams, 'git', ['rev-parse', 'HEAD']);
		return async () => {
			if (started === null || started === '') return null;
			if ((await out(seams, 'git', ['fetch', '--quiet', 'origin', 'main'])) === null) return null;
			const head = await out(seams, 'git', ['rev-parse', 'origin/main']);
			if (head === null || head === '' || head === started) return null;
			// a checkout ahead of origin/main has nothing newer to pull
			const ahead = await out(seams, 'git', ['merge-base', '--is-ancestor', started, head]);
			return ahead === null ? null : head;
		};
	}
	const started = seams.installedVersion();
	return async () => {
		if (started === null) return null;
		const installed = seams.installedVersion();
		if (installed !== null && isNewer(installed, started)) return installed;
		const published = await out(seams, 'npm', ['view', PACKAGE_NAME, 'version']);
		return published !== null && isNewer(published, started) ? published : null;
	};
}
