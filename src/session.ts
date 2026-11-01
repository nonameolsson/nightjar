// One headless `claude -p` session, run restricted on Nightjar's own settings; every line it prints is kept in its log.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Env } from './git.js';

export interface SessionRequest {
	readonly cwd: string;
	readonly prompt: string;
	// the JSON schema of the final answer, as --json-schema takes it
	readonly schema: object;
	readonly tools: readonly string[];
	// the whole settings object; --restricted reads no settings file of the person's
	readonly settings: object;
	readonly budgetUsd: number;
	readonly minutes: number;
	// the id of a new session, or the one a fix round resumes
	readonly sessionId: string;
	readonly resume?: string;
	readonly model?: string;
	readonly effort?: string;
	readonly log: string;
	readonly allowApiKey: boolean;
	readonly env: Env;
	// a person's stop: the session and everything it started end at once
	readonly signal?: AbortSignal;
}

export type Settled =
	| { readonly kind: 'done'; readonly costUsd: number; readonly output: unknown }
	| { readonly kind: 'stopped'; readonly costUsd: number; readonly why: string }
	| { readonly kind: 'api-key' }
	| { readonly kind: 'rate-limited'; readonly resetsAt: number | null };

export type SessionResult = Settled & { readonly sessionId: string };

export type Session = (req: SessionRequest) => Promise<SessionResult>;

export function sessionArgs(req: SessionRequest): string[] {
	const args = [
		'-p',
		req.prompt,
		'--restricted',
		'--strict-mcp-config',
		'--output-format',
		'stream-json',
		'--verbose',
		'--tools',
		req.tools.join(','),
		'--settings',
		JSON.stringify(req.settings),
		'--json-schema',
		JSON.stringify(req.schema),
		'--max-budget-usd',
		req.budgetUsd.toFixed(2)
	];
	if (req.resume) args.push('--resume', req.resume);
	else args.push('--session-id', req.sessionId);
	if (req.model) args.push('--model', req.model);
	if (req.effort) args.push('--effort', req.effort);
	return args;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// What one stream-json line settles, or null while the session goes on.
export function settle(line: unknown, allowApiKey: boolean): Settled | null {
	if (!isObject(line)) return null;
	// a key in use bills per token, beside the person's plan, unless --use-api-key chose it
	if (line.type === 'system' && line.subtype === 'init') {
		return !allowApiKey && line.apiKeySource !== 'none' ? { kind: 'api-key' } : null;
	}
	if (line.type === 'rate_limit_event') {
		const info = line.rate_limit_info;
		if (!isObject(info) || info.status !== 'rejected') return null;
		return {
			kind: 'rate-limited',
			resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null
		};
	}
	if (line.type !== 'result') return null;
	const costUsd = typeof line.total_cost_usd === 'number' ? line.total_cost_usd : 0;
	if (line.subtype === 'error_max_budget_usd') {
		return { kind: 'stopped', costUsd, why: 'it reached its budget' };
	}
	if (line.is_error === true) {
		return { kind: 'stopped', costUsd, why: `it ended with ${String(line.subtype)}` };
	}
	if (!isObject(line.structured_output)) {
		return { kind: 'stopped', costUsd, why: 'it gave no structured answer' };
	}
	return { kind: 'done', costUsd, output: line.structured_output };
}

const TAIL = 2000;

// `command` is the seam a spec swaps for a stand-in.
export function runSession(req: SessionRequest, command = 'claude'): Promise<SessionResult> {
	mkdirSync(dirname(req.log), { recursive: true });
	const log = createWriteStream(req.log, { flags: 'a' });
	return new Promise((done) => {
		const child = spawn(command, sessionArgs(req), {
			cwd: req.cwd,
			env: req.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			// its own process group, so a stop also ends every command it started
			detached: true
		});
		const stop = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
			} catch {
				// the group has already ended
			}
		};
		let stderr = '';
		let settled: Settled | null = null;
		let finished = false;
		const end = (outcome: Settled) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			req.signal?.removeEventListener('abort', abort);
			stop();
			const result = { ...outcome, sessionId: req.resume ?? req.sessionId };
			// a log that failed is already closed, and would never call back
			if (log.errored) done(result);
			else log.end(() => done(result));
		};
		const timer = setTimeout(
			() => end({ kind: 'stopped', costUsd: 0, why: `it ran past ${String(req.minutes)} minutes` }),
			req.minutes * 60_000
		);
		const abort = () => end({ kind: 'stopped', costUsd: 0, why: 'stopped by a person' });
		if (req.signal?.aborted) abort();
		req.signal?.addEventListener('abort', abort, { once: true });
		child.stderr.on('data', (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-TAIL);
		});
		createInterface({ input: child.stdout }).on('line', (text) => {
			log.write(`${text}\n`);
			let line: unknown;
			try {
				line = JSON.parse(text);
			} catch {
				return;
			}
			const now = settle(line, req.allowApiKey);
			if (now === null) return;
			// the result is not always the last line, so a session that settled is let finish
			if (now.kind === 'done' || now.kind === 'stopped') settled = now;
			else end(now);
		});
		// a log that cannot be written stops the session; thrown, it would leave the Feature marked as worked on
		log.on('error', (fault) =>
			end({ kind: 'stopped', costUsd: 0, why: `its log could not be written: ${fault.message}` })
		);
		child.on('error', (fault) =>
			end({ kind: 'stopped', costUsd: 0, why: `claude could not start: ${fault.message}` })
		);
		child.on('close', (code) => {
			const last = stderr.trim().split('\n').pop() ?? '';
			end(
				settled ?? {
					kind: 'stopped',
					costUsd: 0,
					why: `claude exited with code ${String(code)} and no result${last ? `: ${last}` : ''}`
				}
			);
		});
	});
}
