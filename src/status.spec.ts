import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { record } from './ledger.js';
import { readStatus, StatusBoard } from './status.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'nightjar-status-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = new Date(2026, 9, 30, 9, 0);
const board = (path: string, now = () => at) =>
	new StatusBoard({ path, ledger: join(dir, 'runs.jsonl'), now, pid: 42, dailyUsd: 60 });

describe('StatusBoard', () => {
	it('writes what Nightjar does now, with the day spent so far', () => {
		const path = join(dir, 'nested', 'status.json');
		record(join(dir, 'runs.jsonl'), {
			at: new Date(2026, 9, 30, 8).toISOString(),
			repo: 'o/r',
			feature: 1,
			ticket: 2,
			branch: 'factory/1-a',
			step: 'build',
			session: 's',
			costUsd: 0.4,
			outcome: 'built'
		});
		board(path).doing({
			kind: 'building',
			feature: 262,
			ticket: 263,
			step: 'fix',
			round: 2,
			rounds: 3,
			session: 'abc',
			startedAt: at.toISOString()
		});
		expect(readStatus(path)).toEqual({
			at: at.toISOString(),
			pid: 42,
			spentTodayUsd: 0.4,
			dailyUsd: 60,
			doing: {
				kind: 'building',
				feature: 262,
				ticket: 263,
				step: 'fix',
				round: 2,
				rounds: 3,
				session: 'abc',
				startedAt: at.toISOString()
			},
			recent: [],
			codeMoved: null
		});
		// written by a rename, so a reader never meets half a file
		expect(readdirSync(join(dir, 'nested'))).toEqual(['status.json']);
	});

	it('keeps the last ten events, numbered, and goes on numbering after a restart', () => {
		const path = join(dir, 'status.json');
		const first = board(path);
		first.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		for (let t = 1; t <= 11; t += 1) first.happened({ kind: 'built', feature: 1, ticket: t });
		const recent = readStatus(path)?.recent ?? [];
		expect(recent).toHaveLength(10);
		expect(recent[0]).toEqual({
			kind: 'built',
			feature: 1,
			ticket: 2,
			seq: 2,
			at: at.toISOString()
		});
		expect(recent.at(-1)?.seq).toBe(11);

		const second = board(path);
		second.happened({ kind: 'pull', feature: 1, url: 'https://pr/9' });
		const after = readStatus(path);
		expect(after?.recent.at(-1)).toMatchObject({ kind: 'pull', seq: 12 });
		// what Nightjar does is not carried over: a new process says it afresh
		expect(after?.doing).toEqual({ kind: 'off' });
	});

	it('reads no file, or a broken one, as no status', () => {
		expect(readStatus(join(dir, 'none.json'))).toBeNull();
		const broken = join(dir, 'broken.json');
		writeFileSync(broken, '{"at":');
		expect(readStatus(broken)).toBeNull();
		expect(board(broken)).toBeInstanceOf(StatusBoard);
	});
});
