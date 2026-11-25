// The one reader over .factory/ that the live views share: status.json, the session tail and what completed.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { logsPath } from './coding-agent.js';
import {
	builtOn,
	builtOnFeature,
	ledgerPath,
	medianTicketMs,
	spends,
	spentOnFeature
} from './ledger.js';
import { renderSession } from './session-render.js';
import {
	buildsOf,
	featureStart,
	readStatus,
	statusPath,
	type Building,
	type Event,
	type Status
} from './status.js';

export type Done = Extract<Event, { kind: 'pull' | 'failed' }>;

export interface Completed {
	readonly event: Done;
	// what this build's sessions cost: those after the Feature's previous outcome, up to this one
	readonly costUsd: number;
	// the ledger's built events for this build, counted over the same sessions; absent in a hand-made view
	readonly builtTickets?: number;
}

// One busy Slot's build as a view shows it: its own Session tail and what its sessions cost.
export interface BuildView {
	readonly build: Building;
	// the last readable lines of this build's Session log, oldest first
	readonly tail: readonly string[];
	// what this build's sessions cost since it started
	readonly costUsd: number;
}

export interface FactoryView {
	readonly status: Status | null;
	// status.json's pid is not alive, whatever `doing` says
	readonly stopped: boolean;
	// the last readable lines of the oldest build's Session log, oldest first
	readonly tail: readonly string[];
	// one entry per busy Slot, oldest first; absent in a hand-made view, where `buildViews` makes one from `tail` and `featureCostUsd`
	readonly builds?: readonly BuildView[];
	// the pull and failed events in `recent`, oldest first
	readonly completed: readonly Completed[];
	// what the oldest build's sessions cost since it started; 0 when nothing is building
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

function sessionTail(root: string, session: string | null, keep: number): string[] {
	if (session === null) return [];
	const text = readEnd(join(logsPath(root), `${session}.jsonl`));
	if (text === null) return [];
	return renderSession(text.split('\n'))
		.map((line) => line.text)
		.slice(-keep);
}

const isDone = (event: Event): event is Done => event.kind === 'pull' || event.kind === 'failed';

// What a view shows, read from the repo root's .factory/ and nothing else.
export function readFactory(root: string, options: ReadOptions = {}): FactoryView {
	const status = readStatus(statusPath(root));
	const alive = options.alive ?? pidAlive;
	const spent = spends(ledgerPath(root));
	const keep = options.tail ?? TAIL_LINES;
	// an older file's `doing` is its one build
	const busy = status === null ? [] : buildsOf(status);
	const builds = busy.map((build): BuildView => ({
		build,
		tail: sessionTail(root, build.session, keep),
		// a session recorded the moment the build starts is its own
		costUsd: spentOnFeature(spent, build.feature, Date.parse(featureStart(build)) - 1, null)
	}));
	const done = (status?.recent ?? []).filter(isDone);
	return {
		status,
		builds,
		// the oldest build's, which an older reader follows
		featureCostUsd: builds[0]?.costUsd ?? 0,
		medianTicketMs: medianTicketMs(spent),
		builtToday: builtOn(ledgerPath(root), (options.now ?? (() => new Date()))()),
		stopped: status !== null && !alive(status.pid),
		tail: builds[0]?.tail ?? [],
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
