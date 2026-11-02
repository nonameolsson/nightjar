// The one reader over .factory/ that the live views share: status.json, the session tail and what completed.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { costByFeature } from './ledger.js';
import { readStatus, statusPath, type Event, type Status } from './status.js';

export type Done = Extract<Event, { kind: 'pull' | 'failed' }>;

export interface Completed {
	readonly event: Done;
	// what the Feature's sessions cost, over the whole ledger
	readonly costUsd: number;
}

export interface FactoryView {
	readonly status: Status | null;
	// status.json's pid is not alive, whatever `doing` says
	readonly stopped: boolean;
	// the last readable lines of the current session's log, oldest first
	readonly tail: readonly string[];
	// the pull and failed events in `recent`, oldest first
	readonly completed: readonly Completed[];
}

export interface ReadOptions {
	readonly alive?: (pid: number) => boolean;
	// how many lines of the session to keep
	readonly tail?: number;
}

const TAIL_LINES = 20;
// the end of a log is enough for a tail; a line cut at the start of it does not parse and is skipped
const TAIL_BYTES = 256 * 1024;

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (fault) {
		// signalling a process of another user is refused, but it exists
		return (fault as NodeJS.ErrnoException).code === 'EPERM';
	}
}

const Line = z.looseObject({
	type: z.string(),
	message: z.looseObject({ content: z.array(z.looseObject({ type: z.string() })) }).optional()
});
const Text = z.looseObject({ text: z.string() });
const ToolUse = z.looseObject({
	name: z.string(),
	input: z.looseObject({ command: z.string().optional(), file_path: z.string().optional() })
});

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

// What one stream-json line of a session shows: assistant text, and each tool call as its name plus command or file path.
function shown(text: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	const line = Line.safeParse(value);
	if (!line.success || line.data.type !== 'assistant') return [];
	const out: string[] = [];
	for (const block of line.data.message?.content ?? []) {
		if (block.type === 'text') {
			const got = Text.safeParse(block);
			if (got.success && oneLine(got.data.text) !== '') out.push(oneLine(got.data.text));
		} else if (block.type === 'tool_use') {
			const got = ToolUse.safeParse(block);
			if (got.success) {
				const target = got.data.input.command ?? got.data.input.file_path;
				out.push(oneLine(target === undefined ? got.data.name : `${got.data.name} ${target}`));
			}
		}
	}
	return out;
}

function readEnd(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(path, 'r');
	} catch {
		return null;
	}
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		return buffer.toString('utf8');
	} finally {
		closeSync(fd);
	}
}

function sessionTail(root: string, status: Status | null, keep: number): string[] {
	const session = status?.doing.kind === 'building' ? status.doing.session : null;
	if (session === null) return [];
	const text = readEnd(join(root, '.factory', 'logs', `${session}.jsonl`));
	if (text === null) return [];
	return text.split('\n').flatMap(shown).slice(-keep);
}

const isDone = (event: Event): event is Done => event.kind === 'pull' || event.kind === 'failed';

// What a view shows, read from the repo root's .factory/ and nothing else.
export function readFactory(root: string, options: ReadOptions = {}): FactoryView {
	const status = readStatus(statusPath(root));
	const alive = options.alive ?? pidAlive;
	const costs = costByFeature(join(root, '.factory', 'runs.jsonl'));
	return {
		status,
		stopped: status !== null && !alive(status.pid),
		tail: sessionTail(root, status, options.tail ?? TAIL_LINES),
		completed: (status?.recent ?? [])
			.filter(isDone)
			.map((event) => ({ event, costUsd: costs.get(event.feature) ?? 0 }))
	};
}
