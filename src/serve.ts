// A Workflow's serve command: started in the background for its Steps, stopped after them.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import type { Env } from './git.js';

export type Served =
	{ readonly ok: true; stop(): Promise<void> } | { readonly ok: false; readonly tail: string };

// `port` is the one the command listens on; null waits for nothing.
export type Serve = (
	command: string,
	cwd: string,
	env: Env,
	port: number | null
) => Promise<Served>;

const TAIL = 2000;
const READY_MS = 60_000;

const listening = (port: number) =>
	new Promise<boolean>((done) => {
		const socket = connect({ port, host: '127.0.0.1' });
		socket.once('connect', () => {
			socket.destroy();
			done(true);
		});
		socket.once('error', () => done(false));
	});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const startServe: Serve = async (command, cwd, env, port) => {
	// its own process group, so stopping it also ends what it started
	const child = spawn('sh', ['-c', command], {
		cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	let output = '';
	const keep = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-TAIL);
	};
	child.stdout.on('data', keep);
	child.stderr.on('data', keep);
	let exited: number | null | undefined;
	let failed = '';
	child.once('exit', (code) => {
		exited = code;
	});
	child.once('error', (fault) => {
		failed = `sh could not start: ${fault.message}`;
	});
	const stop = () =>
		new Promise<void>((done) => {
			if (exited !== undefined || child.pid === undefined) return done();
			child.once('exit', () => done());
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				done();
			}
		});
	const deadline = Date.now() + READY_MS;
	while (port !== null && !(await listening(port))) {
		if (failed !== '' || exited !== undefined || Date.now() > deadline) {
			await stop();
			const why =
				failed ||
				(exited === undefined
					? `nothing listened on port ${String(port)} in time`
					: `it exited with code ${String(exited)}`);
			return { ok: false, tail: `${why}${output.trim() ? `\n${output.trim()}` : ''}` };
		}
		await pause(200);
	}
	return { ok: true, stop };
};
