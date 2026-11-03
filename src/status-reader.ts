// The one reader over .factory/ that the live views share: status.json, the session tail and what completed.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ledgerPath } from './build.js';
import { logsPath } from './coding-agent.js';
import { builtOn, builtOnFeature, medianTicketMs, spends, spentOnFeature } from './ledger.js';
import { featureStart, readStatus, statusPath, type Event, type Status } from './status.js';

export type Done = Extract<Event, { kind: 'pull' | 'failed' }>;

export interface Completed {
	readonly event: Done;
	// what this build's sessions cost: those after the Feature's previous outcome, up to this one
	readonly costUsd: number;
	// the ledger's built events for this build, counted over the same sessions; absent in a hand-made view
	readonly builtTickets?: number;
}

export interface FactoryView {
	readonly status: Status | null;
	// status.json's pid is not alive, whatever `doing` says
	readonly stopped: boolean;
	// the last readable lines of the current session's log, oldest first
	readonly tail: readonly string[];
	// the pull and failed events in `recent`, oldest first
	readonly completed: readonly Completed[];
	// what the current build's sessions cost since it started; 0 when nothing is building
	readonly featureCostUsd: number;
	// Tickets built on the local day
	readonly builtToday: number;
	// the median duration of a recorded Ticket build; null with none recorded; absent in a hand-made view
	readonly medianTicketMs?: number | null;
}

export interface ReadOptions {
	readonly alive?: (pid: number) => boolean;
	// how many lines of the session to keep
	readonly tail?: number;
	readonly now?: () => Date;
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
	const text = readEnd(join(logsPath(root), `${session}.jsonl`));
	if (text === null) return [];
	return text.split('\n').flatMap(shown).slice(-keep);
}

const isDone = (event: Event): event is Done => event.kind === 'pull' || event.kind === 'failed';

// What a view shows, read from the repo root's .factory/ and nothing else.
export function readFactory(root: string, options: ReadOptions = {}): FactoryView {
	const status = readStatus(statusPath(root));
	const alive = options.alive ?? pidAlive;
	const spent = spends(ledgerPath(root));
	const doing = status?.doing;
	const done = (status?.recent ?? []).filter(isDone);
	return {
		status,
		featureCostUsd:
			doing?.kind === 'building'
				? // a session recorded the moment the build starts is its own
					spentOnFeature(spent, doing.feature, Date.parse(featureStart(doing)) - 1, null)
				: 0,
		medianTicketMs: medianTicketMs(spent),
		builtToday: builtOn(ledgerPath(root), (options.now ?? (() => new Date()))()),
		stopped: status !== null && !alive(status.pid),
		tail: sessionTail(root, status, options.tail ?? TAIL_LINES),
		completed: done.map((event, i) => {
			const before = done.slice(0, i).findLast((e) => e.feature === event.feature);
			const after = before === undefined ? null : Date.parse(before.at);
			return {
				event,
				costUsd: spentOnFeature(spent, event.feature, after, Date.parse(event.at)),
				builtTickets: builtOnFeature(spent, event.feature, after, Date.parse(event.at))
			};
		})
	};
}
