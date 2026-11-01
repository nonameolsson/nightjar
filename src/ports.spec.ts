// A run holds its ports for its whole life: two runs a minute apart must never share one.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimPorts, FIRST_PORT, portEnv } from './ports.js';

// no machine runs this many processes, so the pid is dead
const DEAD = 99_999_999;
const allFree = () => Promise.resolve(true);
const COUNT = 5;

let locks: string;
beforeEach(() => {
	locks = mkdtempSync(join(tmpdir(), 'nightjar-ports-'));
});
afterEach(() => rmSync(locks, { recursive: true, force: true }));

describe('claimPorts', () => {
	it('gives a second live run the next block while the first holds its own', async () => {
		const first = await claimPorts({ count: COUNT, locks, free: allFree });
		// the parent of this process is alive for as long as the spec runs
		const second = await claimPorts({ count: COUNT, locks, pid: process.ppid, free: allFree });
		expect(first?.port).toBe(FIRST_PORT);
		expect(second?.port).toBe(FIRST_PORT + COUNT);
		expect(readFileSync(join(locks, String(FIRST_PORT)), 'utf8')).toBe(String(process.pid));
	});

	it('holds as many ports as the config asks for, not a fixed five', async () => {
		const first = await claimPorts({ count: 2, locks, free: allFree });
		const second = await claimPorts({ count: 2, locks, pid: process.ppid, free: allFree });
		expect(first?.port).toBe(FIRST_PORT);
		expect(second?.port).toBe(FIRST_PORT + 2);
	});

	it('never lets a run with another count take a port a live run holds', async () => {
		await claimPorts({ count: 5, locks, free: allFree });
		const other = await claimPorts({ count: 3, locks, pid: process.ppid, free: allFree });
		// the block at 4480 would overlap the first run's last two ports
		expect(other?.port).toBe(FIRST_PORT + 6);
	});

	it('takes over the block of a run that died', async () => {
		writeFileSync(join(locks, String(FIRST_PORT)), String(DEAD));
		expect((await claimPorts({ count: COUNT, locks, free: allFree }))?.port).toBe(FIRST_PORT);
	});

	it('skips a block with a port that something else listens on', async () => {
		const busy = (port: number) => Promise.resolve(port !== FIRST_PORT + 2);
		expect((await claimPorts({ count: COUNT, locks, free: busy }))?.port).toBe(FIRST_PORT + COUNT);
	});

	it('gives the block back on release, and only its own', async () => {
		const claim = await claimPorts({ count: COUNT, locks, free: allFree });
		claim?.release();
		const again = await claimPorts({ count: COUNT, locks, pid: process.ppid, free: allFree });
		expect(again?.port).toBe(FIRST_PORT);
		claim?.release();
		expect(readFileSync(join(locks, String(FIRST_PORT)), 'utf8')).toBe(String(process.ppid));
	});

	it('clears a picker that died while it picked', async () => {
		mkdirSync(join(locks, '.picking'));
		writeFileSync(join(locks, '.picking', 'pid'), String(DEAD));
		expect((await claimPorts({ count: COUNT, locks, free: allFree }))?.port).toBe(FIRST_PORT);
	});

	it('finds no block when none is free', async () => {
		expect(
			await claimPorts({ count: COUNT, locks, free: () => Promise.resolve(false) })
		).toBeNull();
	});
});

describe('portEnv', () => {
	it('names the first ports in order, one variable each', () => {
		expect(portEnv(4500, ['WEB_PORT', 'DB_PORT'])).toEqual({ WEB_PORT: '4500', DB_PORT: '4501' });
	});
});
