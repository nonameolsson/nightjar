import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSession, sessionArgs, settle, type SessionRequest } from './session.js';

const init = (apiKeySource = 'none') => ({ type: 'system', subtype: 'init', apiKeySource });
const result = (over: Record<string, unknown> = {}) => ({
	type: 'result',
	subtype: 'success',
	is_error: false,
	total_cost_usd: 1.25,
	structured_output: { outcome: 'built' },
	...over
});

describe('settle', () => {
	it('answers with the structured output and the cost', () => {
		expect(settle(result(), false)).toEqual({
			kind: 'done',
			costUsd: 1.25,
			output: { outcome: 'built' }
		});
	});

	it('stops a session that bills an API key the person did not choose', () => {
		expect(settle(init('ANTHROPIC_API_KEY'), false)).toEqual({ kind: 'api-key' });
		expect(settle(init('ANTHROPIC_API_KEY'), true)).toBeNull();
		expect(settle(init(), false)).toBeNull();
	});

	it('stops on a rejected usage limit, with when it resets', () => {
		const line = {
			type: 'rate_limit_event',
			rate_limit_info: { status: 'rejected', resetsAt: 1793390400 }
		};
		expect(settle(line, false)).toEqual({ kind: 'rate-limited', resetsAt: 1793390400 });
		expect(
			settle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, false)
		).toBeNull();
	});

	it('names the stop of a result that is an error, or that has no structured output', () => {
		expect(
			settle(
				result({ is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 15.3 }),
				false
			)
		).toEqual({ kind: 'stopped', costUsd: 15.3, why: 'it reached its budget' });
		expect(settle(result({ is_error: true, subtype: 'error_max_turns' }), false)).toEqual({
			kind: 'stopped',
			costUsd: 1.25,
			why: 'it ended with error_max_turns'
		});
		expect(settle(result({ structured_output: undefined }), false)).toEqual({
			kind: 'stopped',
			costUsd: 1.25,
			why: 'it gave no structured answer'
		});
	});
});

const request = (over: Partial<SessionRequest> = {}): SessionRequest => ({
	cwd: '.',
	prompt: 'build it',
	schema: { type: 'object' },
	tools: ['Read', 'Bash'],
	settings: { permissions: { allow: ['Read'] } },
	budgetUsd: 15,
	minutes: 60,
	sessionId: '11111111-2222-4333-8444-555555555555',
	log: 'unused',
	allowApiKey: false,
	env: {},
	...over
});

describe('sessionArgs', () => {
	it('starts a restricted, headless session on its own settings and limits', () => {
		const args = sessionArgs(request({ model: 'sonnet', effort: 'high' }));
		expect(args.slice(0, 2)).toEqual(['-p', 'build it']);
		expect(args).toEqual(
			expect.arrayContaining(['--restricted', '--strict-mcp-config', '--verbose'])
		);
		const value = (flag: string) => args[args.indexOf(flag) + 1];
		expect(value('--output-format')).toBe('stream-json');
		expect(value('--tools')).toBe('Read,Bash');
		expect(JSON.parse(value('--settings') ?? '')).toEqual({ permissions: { allow: ['Read'] } });
		expect(value('--max-budget-usd')).toBe('15.00');
		expect(value('--session-id')).toBe('11111111-2222-4333-8444-555555555555');
		expect(value('--model')).toBe('sonnet');
		expect(value('--effort')).toBe('high');
		expect(args).not.toContain('--resume');
	});

	it('resumes a session by its id in place of starting one', () => {
		const args = sessionArgs(request({ resume: 'abc' }));
		expect(args[args.indexOf('--resume') + 1]).toBe('abc');
		expect(args).not.toContain('--session-id');
	});
});

describe('runSession', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'nightjar-session-'));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	// a stand-in claude that prints the given lines, then sleeps for the given seconds
	function fake(lines: unknown[], sleep = 0): string {
		const path = join(dir, 'claude');
		const out = lines.map((l) => `echo '${JSON.stringify(l)}'`).join('\n');
		writeFileSync(path, `#!/bin/sh\n${out}\nsleep ${String(sleep)}\n`);
		chmodSync(path, 0o755);
		return path;
	}

	it('keeps every line in the log and settles on the result', async () => {
		const command = fake([init(), result()]);
		const log = join(dir, 'run.jsonl');
		const got = await runSession(request({ cwd: dir, log }), command);
		expect(got).toEqual({
			kind: 'done',
			costUsd: 1.25,
			output: { outcome: 'built' },
			sessionId: '11111111-2222-4333-8444-555555555555'
		});
		expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
	});

	// The first real run died here: its log's open error escaped every catch and left the Feature agent-working.
	it('makes the folder of its log', async () => {
		const command = fake([init(), result()]);
		const log = join(dir, '.factory', 'logs', 'run.jsonl');
		const got = await runSession(request({ cwd: dir, log }), command);
		expect(got.kind).toBe('done');
		expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
	});

	it('stops a session that runs past its minutes', async () => {
		const command = fake([init()], 30);
		const got = await runSession(
			request({ cwd: dir, log: join(dir, 'run.jsonl'), minutes: 0.01 }),
			command
		);
		expect(got).toMatchObject({ kind: 'stopped', why: 'it ran past 0.01 minutes' });
	});

	it('names the exit of a session that ends with no result', async () => {
		const command = fake([init()]);
		const got = await runSession(request({ cwd: dir, log: join(dir, 'run.jsonl') }), command);
		expect(got).toMatchObject({ kind: 'stopped', why: 'claude exited with code 0 and no result' });
	});
});
