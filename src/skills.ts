// The skills a headless Claude session loads, read off the init line it prints before it asks the model anything.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Env } from './git.js';

export type LoadedSkills = (cwd: string, env: Env) => Promise<string[] | null>;

const WAIT_MS = 30_000;

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

// The session is started as a build starts one and killed at its init line, so it costs nothing.
export const loadedSkills: LoadedSkills = (cwd, env) =>
	new Promise((done) => {
		const child = spawn(
			'claude',
			[
				'-p',
				'Reply with ok.',
				'--restricted',
				'--strict-mcp-config',
				'--output-format',
				'stream-json',
				'--verbose',
				'--tools',
				'Skill'
			],
			{ cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true }
		);
		let finished = false;
		const end = (skills: string[] | null) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			try {
				if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
			} catch {
				// the group has already ended
			}
			done(skills);
		};
		const timer = setTimeout(() => end(null), WAIT_MS);
		createInterface({ input: child.stdout }).on('line', (text) => {
			try {
				const line = JSON.parse(text) as Record<string, unknown>;
				if (line.type === 'system' && line.subtype === 'init') {
					end([...new Set([...strings(line.skills), ...strings(line.slash_commands)])]);
				}
			} catch {
				// not a JSON line
			}
		});
		child.on('error', () => end(null));
		child.on('close', () => end(null));
	});

// Whether `name` is among the loaded skills, bare or under a plugin's prefix.
export const isLoaded = (loaded: readonly string[], name: string) =>
	loaded.some((l) => l === name || l.endsWith(`:${name}`));
