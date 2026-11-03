import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { record } from './ledger.js';
import { readStatus, StatusFile, type Doing, type TicketProgress } from './status.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'nightjar-status-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = new Date(2026, 9, 30, 9, 0);
const file = (path: string, now = () => at) =>
	new StatusFile({ path, ledger: join(dir, 'runs.jsonl'), now, pid: 42, dailyUsd: 60 });

describe('StatusFile', () => {
	it('writes what Nightjar does now, with the day spent so far', () => {
		const path = join(dir, 'nested', 'status.json');
		record(join(dir, 'runs.jsonl'), {
			at: new Date(2026, 9, 30, 8).toISOString(),
			repo: 'o/r',
			feature: '1',
			ticket: '2',
			branch: 'factory/1-a',
			step: 'build',
			session: 's',
			costUsd: 0.4,
			outcome: 'built'
		});
		file(path).doing({
			kind: 'building',
			feature: '262',
			ticket: '263',
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
				feature: '262',
				ticket: '263',
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
		const first = file(path);
		first.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		for (let t = 1; t <= 11; t += 1)
			first.happened({ kind: 'built', feature: '1', ticket: String(t) });
		const recent = readStatus(path)?.recent ?? [];
		expect(recent).toHaveLength(10);
		expect(recent[0]).toEqual({
			kind: 'built',
			feature: '1',
			ticket: '2',
			seq: 2,
			at: at.toISOString()
		});
		expect(recent.at(-1)?.seq).toBe(11);

		const second = file(path);
		second.happened({ kind: 'pull', feature: '1', url: 'https://pr/9' });
		const after = readStatus(path);
		expect(after?.recent.at(-1)).toMatchObject({ kind: 'pull', seq: 12 });
		// what Nightjar does is not carried over: a new process says it afresh
		expect(after?.doing).toEqual({ kind: 'off' });
	});

	it('writes the Queue and Waiting on you with when they were refreshed, and drops them when the run is off', () => {
		const path = join(dir, 'status.json');
		const status = file(path);
		status.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		expect(readStatus(path)?.queue).toBeUndefined();
		const waitingOnYou = {
			items: [{ kind: 'ticket' as const, id: '4', title: 'Retries', why: 'needs info' }],
			trackerCannotList: true
		};
		status.refreshed([{ id: '7', title: 'Saved filters' }], waitingOnYou);
		expect(readStatus(path)).toMatchObject({
			queue: [{ id: '7', title: 'Saved filters' }],
			waitingOnYou,
			refreshedAt: at.toISOString()
		});
		// a later write keeps them
		status.happened({ kind: 'stale', commit: 'abc' });
		expect(readStatus(path)?.queue).toHaveLength(1);
		status.doing({ kind: 'off' });
		const off = readStatus(path);
		expect(off?.queue).toBeUndefined();
		expect(off?.waitingOnYou).toBeUndefined();
		expect(off?.refreshedAt).toBeUndefined();
	});

	it("lists the building Feature's Tickets that need info or a person in Waiting on you as the build runs, and drops them with the Feature", () => {
		const path = join(dir, 'status.json');
		const status = file(path);
		const feature = { kind: 'feature' as const, id: '10', title: 'Asks', why: 'needs info' };
		// the last Feature's Ticket, which must not show while another Feature builds
		const old = { kind: 'ticket' as const, id: '3', title: 'Old', why: 'needs a person' };
		status.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		status.refreshed([], { items: [feature, old], trackerCannotList: false });
		const building = (tickets: TicketProgress[]): Doing => ({
			kind: 'building',
			feature: '20',
			ticket: '21',
			step: 'build',
			round: null,
			rounds: null,
			session: null,
			startedAt: at.toISOString(),
			tickets
		});
		status.doing(
			building([
				{ id: '21', title: 'Now', state: 'building' },
				{ id: '22', title: 'Asks', state: 'waiting', why: 'needs info' },
				{ id: '23', title: 'Stuck', state: 'waiting', why: 'needs a person' },
				{ id: '24', title: 'After', state: 'waiting', why: 'blocked by #21' }
			])
		);
		expect(readStatus(path)?.waitingOnYou?.items).toEqual([
			feature,
			{ kind: 'ticket', id: '22', title: 'Asks', why: 'needs info' },
			{ kind: 'ticket', id: '23', title: 'Stuck', why: 'needs a person' }
		]);
		// updated as the build runs
		status.doing(
			building([
				{ id: '21', title: 'Now', state: 'built' },
				{ id: '22', title: 'Asks', state: 'building' },
				{ id: '23', title: 'Stuck', state: 'waiting', why: 'needs a person' }
			])
		);
		expect(readStatus(path)?.waitingOnYou?.items).toEqual([
			feature,
			{ kind: 'ticket', id: '23', title: 'Stuck', why: 'needs a person' }
		]);
		// the Feature is over: what the loop last said shows again
		status.doing({ kind: 'idle', nextPollAt: at.toISOString() });
		expect(readStatus(path)?.waitingOnYou?.items).toEqual([feature, old]);
	});

	it("starts a new run without the last run's Queue", () => {
		const path = join(dir, 'status.json');
		file(path).refreshed([{ id: '7', title: 'Saved filters' }], {
			items: [],
			trackerCannotList: true
		});
		file(path).doing({ kind: 'idle', nextPollAt: at.toISOString() });
		expect(readStatus(path)?.queue).toBeUndefined();
	});

	it('reads no file, or a broken one, as no status', () => {
		expect(readStatus(join(dir, 'none.json'))).toBeNull();
		const broken = join(dir, 'broken.json');
		writeFileSync(broken, '{"at":');
		expect(readStatus(broken)).toBeNull();
		expect(file(broken)).toBeInstanceOf(StatusFile);
	});

	it('says whether the run is --watch, so a view can tell when the next poll comes', () => {
		const path = join(dir, 'status.json');
		const file = new StatusFile({
			path,
			ledger: join(dir, 'runs.jsonl'),
			now: () => new Date(2026, 9, 30, 9),
			pid: 42,
			dailyUsd: 60,
			watching: true
		});
		file.doing({ kind: 'off' });
		expect(readStatus(path)?.watching).toBe(true);
	});
});
