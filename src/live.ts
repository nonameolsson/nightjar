// The live terminal view: redraws one block in place each second, in plain ANSI escapes.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderBlock } from './live-view.js';
import { readFactory } from './status-reader.js';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const ERASE_LINE = '\x1b[2K';
const ERASE_BELOW = '\x1b[J';

export interface LiveOptions {
	readonly root: string;
	readonly repo: string;
	readonly out: {
		write: (text: string) => unknown;
		columns?: number;
		// a terminal tells of a resize; an `out` without these only redraws each second
		on?: (event: 'resize', listener: () => void) => unknown;
		off?: (event: 'resize', listener: () => void) => unknown;
	};
	readonly now: () => Date;
	// whether a pid is alive; the machine's own answer unless a spec passes one
	readonly alive?: (pid: number) => boolean;
	// calls `redraw` every second until the returned function is called
	readonly every?: (redraw: () => void) => () => void;
}

export interface Live {
	// the command's own line: shown in the block and appended to .factory/nightjar.log
	readonly say: (line: string) => void;
	// ends the redraws and gives the cursor back; safe to call twice
	readonly stop: () => void;
}

const everySecond = (redraw: () => void) => {
	const timer = setInterval(redraw, 1000);
	return () => clearInterval(timer);
};

export function startLive(o: LiveOptions): Live {
	const logPath = join(o.root, '.factory', 'nightjar.log');
	let newest: string | null = null;
	let last: readonly string[] = [];
	let stopped = false;

	const draw = () => {
		const lines = renderBlock(
			readFactory(o.root, { now: o.now, ...(o.alive === undefined ? {} : { alive: o.alive }) }),
			{
				repo: o.repo,
				width: o.out.columns ?? 80,
				now: o.now(),
				line: newest
			}
		);
		// back over the last block, then each line over the old one, then clear what a shorter block leaves
		// a narrower terminal wraps the old lines onto more rows, so count rows at the width now
		const columns = Math.max(1, o.out.columns ?? 80);
		const height = last.reduce(
			(rows, l) => rows + Math.max(1, Math.ceil(Array.from(l).length / columns)),
			0
		);
		const up = height > 0 ? `\x1b[${String(height)}A\r` : '';
		o.out.write(`${up}${lines.map((l) => `${ERASE_LINE}${l}\n`).join('')}${ERASE_BELOW}`);
		last = lines;
	};

	o.out.write(HIDE);
	draw();
	const cancel = (o.every ?? everySecond)(draw);
	o.out.on?.('resize', draw);

	return {
		say: (line) => {
			newest = `nightjar: ${line}`;
			try {
				mkdirSync(dirname(logPath), { recursive: true });
				appendFileSync(logPath, `${o.now().toISOString()} ${newest}\n`);
			} catch {
				// a log that cannot be written must not stop a build
			}
			draw();
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			cancel();
			o.out.off?.('resize', draw);
			draw();
			o.out.write(SHOW);
		}
	};
}
