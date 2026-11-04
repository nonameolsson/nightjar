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

	describe('when the terminal narrows', () => {
		const ERASE = '\x1b[2K';
		function narrowing() {
			const written: string[] = [];
			let onResize: (() => void) | null = null;
			let removed = false;
			const out = {
				write: (s: string) => void written.push(s),
				columns: 80,
				on: (_e: 'resize', fn: () => void) => {
					onResize = fn;
				},
				off: (_e: 'resize', fn: () => void) => {
					if (fn === onResize) removed = true;
				}
			};
			let tick: (() => void) | null = null;
			const live = startLive({
				root,
				repo: 'o/' + 'x'.repeat(50),
				out,
				now: () => at,
				alive: () => true,
				every: (fn) => {
					tick = fn;
					return () => undefined;
				}
			});
			return {
				out,
				live,
				written,
				tick: () => tick?.(),
				resize: () => onResize?.(),
				removed: () => removed
			};
		}
		const linesOf = (frame: string) =>
			frame
				.split('\n')
				.filter((l) => l.includes(ERASE))
				.map((l) => l.slice(l.indexOf(ERASE) + ERASE.length));

		it('moves up the rows the last lines take at the new width, not their count', () => {
			const w = narrowing();
			const first = linesOf(w.written.join(''));
			const rows = first.reduce((n, l) => n + Math.max(1, Math.ceil(Array.from(l).length / 40)), 0);
			expect(rows).toBeGreaterThan(first.length);
			w.out.columns = 40;
			const before = w.written.length;
			w.tick();
			const frame = w.written.slice(before).join('');
			expect(frame.startsWith(`\x1b[${String(rows)}A\r`)).toBe(true);
		});

		it('redraws at once on a resize', () => {
			const w = narrowing();
			const before = w.written.length;
			w.out.columns = 40;
			w.resize();
			expect(w.written.length).toBeGreaterThan(before);
		});

		it('removes the resize listener on stop', () => {
			const w = narrowing();
			w.live.stop();
			expect(w.removed()).toBe(true);
		});
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
