import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { record } from './ledger.js';
import { readFactory } from './status-reader.js';
import { StatusFile } from './status.js';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-reader-'));
	mkdirSync(join(root, '.factory', 'logs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = new Date(2026, 9, 30, 9, 0);
const live = () => true;
const dead = () => false;

const status = () =>
	new StatusFile({
		path: join(root, '.factory', 'status.json'),
		ledger: join(root, '.factory', 'runs.jsonl'),
		now: () => at,
		pid: 42,
		dailyUsd: 60
	});

const building = (session: string | null) =>
	({
		kind: 'building',
		feature: '1',
		ticket: '2',
		step: 'build',
		round: 1,
		rounds: 3,
		session,
		startedAt: at.toISOString()
	}) as const;

const log = (session: string, lines: readonly unknown[]) =>
	writeFileSync(
		join(root, '.factory', 'logs', `${session}.jsonl`),
		lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
	);

const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });

const ledger = (feature: string | number, costUsd: number) =>
	record(join(root, '.factory', 'runs.jsonl'), {
		at: at.toISOString(),
		repo: 'o/r',
		feature: feature as string,
		ticket: null,
		branch: 'b',
		step: 'build',
		session: 's',
		costUsd,
		outcome: 'built'
	});

describe('readFactory', () => {
	it('reads no status.json as none, with nothing to show', () => {
		expect(readFactory(root, { alive: live })).toEqual({
			status: null,
			stopped: false,
			tail: [],
			completed: []
		});
	});

	it('gives the status as written and says stopped only when its pid is not alive', () => {
		status().doing(building(null));
		const running = readFactory(root, { alive: (pid) => pid === 42 });
		expect(running.status?.doing).toMatchObject({ kind: 'building', ticket: '2' });
		expect(running.stopped).toBe(false);
		// whatever `doing` says, a dead pid is a stopped run
		expect(readFactory(root, { alive: dead }).stopped).toBe(true);
	});

	it('asks the machine whether the pid is alive when not told', () => {
		status().doing({ kind: 'off' });
		expect(readFactory(root).stopped).toBe(true);
		writeFileSync(
			join(root, '.factory', 'status.json'),
			JSON.stringify({ pid: process.pid, recent: [], doing: { kind: 'off' } })
		);
		expect(readFactory(root).stopped).toBe(false);
	});

	it('reads an old status.json that lacks the newer fields', () => {
		writeFileSync(
			join(root, '.factory', 'status.json'),
			JSON.stringify({
				at: at.toISOString(),
				pid: 42,
				spentTodayUsd: 1,
				dailyUsd: 8,
				doing: building('s1'),
				recent: [{ seq: 1, at: at.toISOString(), kind: 'stale', commit: 'abc' }]
			})
		);
		const view = readFactory(root, { alive: live });
		expect(view.status?.queue).toBeUndefined();
		expect(view.status?.waitingOnYou).toBeUndefined();
		expect(view.completed).toEqual([]);
		expect(view.tail).toEqual([]);
	});

	it('tails the session: assistant text, and each tool call by its command or file, without results', () => {
		status().doing(building('s1'));
		log('s1', [
			{ type: 'system', subtype: 'init' },
			assistant({ type: 'text', text: 'Reading the\nmarks module.' }),
			assistant({ type: 'tool_use', name: 'Read', input: { file_path: '/w/src/marks.ts' } }),
			{
				type: 'user',
				message: { content: [{ type: 'tool_result', content: 'export const marks = 1' }] }
			},
			assistant(
				{ type: 'tool_use', name: 'Bash', input: { command: 'npm run check' } },
				{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }
			),
			{ type: 'result', result: 'done' }
		]);
		expect(readFactory(root, { alive: live }).tail).toEqual([
			'Reading the marks module.',
			'Read /w/src/marks.ts',
			'Bash npm run check',
			'TodoWrite'
		]);
	});

	it('keeps the last N readable lines, and skips a line that does not parse', () => {
		status().doing(building('s1'));
		log('s1', [
			assistant({ type: 'text', text: 'one' }),
			'{"type":"assistant","message":',
			assistant({ type: 'text', text: 'two' }),
			'not json at all',
			assistant({ type: 'text', text: 'three' }),
			'{"type":"assistant"}',
			assistant({ type: 'text', text: 'four' })
		]);
		expect(readFactory(root, { alive: live, tail: 3 }).tail).toEqual(['two', 'three', 'four']);
	});

	it('has no tail when the session has no log yet, or nothing is building', () => {
		status().doing(building('missing'));
		expect(readFactory(root, { alive: live }).tail).toEqual([]);
		status().doing({ kind: 'idle', nextPollAt: at.toISOString() });
		expect(readFactory(root, { alive: live }).tail).toEqual([]);
	});

	it('lists what completed, the pull and failed events, each with its Feature cost summed', () => {
		ledger('1', 1.5);
		ledger('1', 0.5);
		ledger('2', 3);
		// a line written before ids were strings
		ledger(4, 0.25);
		const file = status();
		file.happened({ kind: 'built', feature: '1', ticket: '9' });
		file.happened({ kind: 'pull', feature: '1', url: 'https://pr/1' });
		file.happened({ kind: 'failed', feature: '2', why: 'check red' });
		file.happened({ kind: 'needs-info', feature: '3', ticket: null, why: 'unclear' });
		file.happened({ kind: 'pull', feature: '4', url: 'https://pr/4' });
		file.happened({ kind: 'pull', feature: '5', url: 'https://pr/5' });
		const { completed } = readFactory(root, { alive: live });
		expect(completed.map((c) => [c.event.kind, c.event.feature, c.costUsd])).toEqual([
			['pull', '1', 2],
			['failed', '2', 3],
			['pull', '4', 0.25],
			['pull', '5', 0]
		]);
	});
});
