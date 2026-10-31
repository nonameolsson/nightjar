import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Status } from '../../../src/status-shape.js';
import { StatusFile } from '../../../src/status.js';
import { line, toast } from './format';

const NOW = new Date(2026, 9, 31, 10, 30).getTime();
const at = (h: number, m: number) => new Date(2026, 9, 31, h, m).toISOString();

const status = (doing: Status['doing']): Status => ({
	at: at(10, 29),
	pid: 1,
	spentTodayUsd: 0.4,
	dailyUsd: 60,
	doing,
	recent: [],
	codeMoved: null
});

describe('the status line', () => {
	it('says a fix round, the minutes and the day spent', () => {
		const fix = status({
			kind: 'building',
			feature: '262',
			ticket: '263',
			step: 'fix',
			round: 2,
			rounds: 3,
			session: 's',
			startedAt: at(10, 16)
		});
		expect(line(fix, NOW)).toBe('nightjar: #262 › #263 fix 2/3 · 14m · $0.40 today');
	});

	it('says no round for a first build and no Ticket for a review', () => {
		const build = {
			kind: 'building',
			feature: '262',
			ticket: '263',
			step: 'build',
			round: 1,
			rounds: 3,
			session: 's',
			startedAt: at(10, 30)
		} as const;
		expect(line(status(build), NOW)).toBe('nightjar: #262 › #263 build · 0m · $0.40 today');
		const review = { ...build, ticket: null, step: 'review', round: null, rounds: null } as const;
		expect(line(status(review), NOW)).toBe('nightjar: #262 review · 0m · $0.40 today');
	});

	it('names the next poll when idle, says nothing when off, and counts yesterday as nothing', () => {
		expect(line(status({ kind: 'idle', nextPollAt: at(10, 42) }), NOW)).toBe(
			'nightjar: idle, next poll 10:42 · $0.40 today'
		);
		expect(line(status({ kind: 'off' }), NOW)).toBeUndefined();
		const old = {
			...status({ kind: 'idle', nextPollAt: at(10, 42) }),
			at: new Date(2026, 9, 30, 23).toISOString()
		};
		expect(line(old, NOW)).toContain('$0.00 today');
	});

	it('says why it is paused', () => {
		expect(line(status({ kind: 'paused', why: 'daily limit', until: at(11, 0) }), NOW)).toBe(
			'nightjar: paused until 11:00: daily limit · $0.40 today'
		);
	});

	it('says when the running code is old', () => {
		const old = { ...status({ kind: 'idle', nextPollAt: at(10, 42) }), codeMoved: 'abc1234' };
		expect(line(old, NOW)).toBe(
			'nightjar: idle, next poll 10:42 · $0.40 today · restart: main has new Nightjar code (abc1234)'
		);
	});
});

describe('the toasts', () => {
	const e = { seq: 1, at: at(10, 0) };
	it('name the issue and why', () => {
		expect(toast({ ...e, kind: 'built', feature: '262', ticket: '263' })).toBe(
			'nightjar: #263 built (#262)'
		);
		expect(
			toast({ ...e, kind: 'needs-info', feature: '262', ticket: null, why: 'it built nothing' })
		).toBe('nightjar: #262 needs a person: it built nothing');
		expect(toast({ ...e, kind: 'failed', feature: '262', why: 'check failed' })).toBe(
			'nightjar: #262 failed: check failed'
		);
		expect(toast({ ...e, kind: 'pull', feature: '262', url: 'https://pr/9' })).toBe(
			'nightjar: #262 draft pull request https://pr/9'
		);
		expect(toast({ ...e, kind: 'stale', commit: 'abc1234' })).toBe(
			'nightjar: main has new Nightjar code (abc1234); restart it from an updated main'
		);
	});
});

describe('the file the writer makes', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'nightjar-plugin-'));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('is read by the plugin into its line and toasts', () => {
		const path = join(dir, '.factory', 'status.json');
		const now = new Date(NOW);
		const file = new StatusFile({
			path,
			ledger: join(dir, 'runs.jsonl'),
			now: () => now,
			pid: 7,
			dailyUsd: 60
		});
		file.happened({ kind: 'built', feature: '5', ticket: '6' });
		file.doing({
			kind: 'building',
			feature: '5',
			ticket: '7',
			step: 'build',
			round: 1,
			rounds: 2,
			session: 's',
			startedAt: now.toISOString()
		});
		const written = JSON.parse(readFileSync(path, 'utf8')) as Status;
		expect(line(written, NOW)).toBe('nightjar: #5 › #7 build · 0m · $0.00 today');
		expect(written.recent.map(toast)).toEqual(['nightjar: #6 built (#5)']);
	});
});
