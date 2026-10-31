// The repo's check command, run in the Feature's worktree after each Ticket and each fix round. Its
// output's end, without colour codes, goes to the fix round and, when it stays red, the pull request.
import { spawn } from 'node:child_process';
import type { Env } from './git.js';

export interface CheckResult {
	readonly ok: boolean;
	readonly tail: string;
}

export type RunCheck = (command: string, cwd: string) => Promise<CheckResult>;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

const TAIL = 80;

export function checkReport(output: string): string {
	const lines = output.replace(ANSI, '').trimEnd().split('\n');
	const end = lines.slice(-TAIL).join('\n');
	const cut = lines.length > TAIL ? ` (last ${String(TAIL)} lines)` : '';
	return `The end of the output${cut}:\n${end}`;
}

// The command is the repo's own, from its committed factory.json, so it runs through the shell.
export function runCheck(command: string, cwd: string, env: Env): Promise<CheckResult> {
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
			done(code === 0 ? { ok: true, tail: '' } : { ok: false, tail: checkReport(output) })
		);
	});
}
