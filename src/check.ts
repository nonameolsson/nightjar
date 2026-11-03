// The repo's check command; when it is red, its gate report goes to the fix round and the pull request.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { gateReport, type Gate } from './gate.js';
import type { Env } from './git.js';

export interface CheckResult {
	readonly ok: boolean;
	readonly tail: string;
}

// Also runs the worktree setup command, with the environment the run hands every command.
export type RunCheck = (command: string, cwd: string, env: Env) => Promise<CheckResult>;

// A stage log is read from inside the worktree only; real paths, so a symlink cannot point out of it.
function readIn(cwd: string): (path: string) => string | null {
	return (path) => {
		try {
			const root = realpathSync(cwd);
			const file = realpathSync(resolve(root, path));
			return file.startsWith(root + sep) ? readFileSync(file, 'utf8') : null;
		} catch {
			return null;
		}
	};
}

// The command is the repo's own, from its committed factory.json, so it runs through the shell.
export function runCheck(
	command: string,
	cwd: string,
	env: Env,
	gate?: Gate
): Promise<CheckResult> {
	return new Promise((done) => {
		const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		const keep = (chunk: Buffer) => {
			output += chunk.toString();
		};
		child.stdout.on('data', keep);
		child.stderr.on('data', keep);
		child.on('error', (fault) => done({ ok: false, tail: `sh could not start: ${fault.message}` }));
		child.on('close', (code) =>
			done(
				code === 0
					? { ok: true, tail: '' }
					: { ok: false, tail: gateReport(output, gate, readIn(cwd)) }
			)
		);
	});
}
