// Never through a shell, so no title or branch name is ever parsed as shell text.
import { execFile } from 'node:child_process';

export type Env = Readonly<Record<string, string | undefined>>;

export interface Run {
	readonly ok: boolean;
	readonly out: string;
	readonly err: string;
	// true when the command itself is not on the PATH
	readonly missing: boolean;
}

export function run(command: string, args: readonly string[], cwd: string, env: Env): Promise<Run> {
	return new Promise((done) => {
		execFile(command, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (fault, out, err) => {
			const missing = (fault as NodeJS.ErrnoException | null)?.code === 'ENOENT';
			done({ ok: fault === null, out, err, missing });
		});
	});
}

export const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';
