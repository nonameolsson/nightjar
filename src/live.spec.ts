import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileSpend } from './ledger.js';
import { startLive } from './live.js';
import { StatusFile } from './status.js';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-live-'));
	mkdirSync(join(root, '.factory'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = new Date(2026, 9, 30, 9, 0, 0);

function world() {
	const written: string[] = [];
	let tick: (() => void) | null = null;
	let cancelled = false;
	const live = startLive({
		root,
		repo: 'o/r',
		out: { write: (s) => void written.push(s), columns: 60 },
		now: () => at,
		alive: () => true,
		every: (fn) => {
			tick = fn;
			return () => {
				cancelled = true;
			};
		}
	});
	return {
		live,
		written,
		tick: () => tick?.(),
		cancelled: () => cancelled,
		text: () => written.join('')
	};
}

describe('startLive', () => {
	it('hides the cursor and draws the block at once', () => {
		const w = world();
		expect(w.written[0]).toBe('\x1b[?25l');
		expect(w.text()).toContain('nightjar  o/r  ·  no run yet');
	});

	it('redraws in place each tick: back up over the last block, and what the reader finds now', () => {
		const w = world();
		const first = w.text().split('\n').length - 1;
		new StatusFile({
			path: join(root, '.factory', 'status.json'),
			spend: fileSpend(join(root, '.factory', 'runs.jsonl')),
			now: () => at,
			pid: 42,
			dailyUsd: 8
		}).doing({ kind: 'idle', nextPollAt: new Date(2026, 9, 30, 9, 1, 12).toISOString() });
		const before = w.written.length;
		w.tick();
		const frame = w.written.slice(before).join('');
		expect(frame.startsWith(`\x1b[${String(first)}A\r`)).toBe(true);
		expect(frame).toContain('idle  ·  next poll 1:12');
	});

	it('shows the newest line said and appends every line to .factory/nightjar.log', () => {
		const w = world();
		w.live.say('#1: building on factory/1');
		w.live.say('#1: draft pull request https://pr/1');
		expect(w.text()).toContain('nightjar: #1: draft pull request https://pr/1');
		const log = readFileSync(join(root, '.factory', 'nightjar.log'), 'utf8')
			.trim()
			.split('\n');
		expect(log).toHaveLength(2);
		expect(log[0]).toMatch(/^2026-.*nightjar: #1: building on factory\/1$/);
	});

	it('on stop ends the timer and gives the cursor back, once', () => {
		const w = world();
		w.live.stop();
		w.live.stop();
		expect(w.cancelled()).toBe(true);
		expect(w.text().split('\x1b[?25h')).toHaveLength(2);
		expect(w.text().endsWith('\x1b[?25h')).toBe(true);
	});
});
