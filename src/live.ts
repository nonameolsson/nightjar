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
	readonly out: { write: (text: string) => unknown; columns?: number };
	readonly now: () => Date;
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
	let height = 0;
	let stopped = false;

	const draw = () => {
		const lines = renderBlock(readFactory(o.root, { now: o.now }), {
			repo: o.repo,
			width: o.out.columns ?? 80,
			now: o.now(),
			line: newest
		});
		// back over the last block, then each line over the old one, then clear what a shorter block leaves
		const up = height > 0 ? `\x1b[${String(height)}A\r` : '';
		o.out.write(`${up}${lines.map((l) => `${ERASE_LINE}${l}\n`).join('')}${ERASE_BELOW}`);
		height = lines.length;
	};

	o.out.write(HIDE);
	draw();
	const cancel = (o.every ?? everySecond)(draw);

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
			draw();
			o.out.write(SHOW);
		}
	};
}
