// The one reader over .factory/ that the live views share: status.json, the session tail and what completed.
// It reads factory.json too, and each building or Completed Feature's Logbook for its Workflow, for the stages a build never runs.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { logsPath } from './coding-agent.js';
import { buildCost, type BuildCost, type Stage } from './build-cost.js';
import { buildStages, neverRun, runningStage, type BuildStage } from './build-stages.js';
import { loadConfig, type Config } from './config.js';
import { fileLogbook, type LogbookEntry } from './logbook.js';
import type { ItemId } from './tracker.js';
import {
	builtOn,
	builtOnFeature,
	ledgerPath,
	linesOnFeature,
	medianTicketMs,
	spends,
	type Spent
} from './ledger.js';
import { lastWeek, type Week } from './last-week.js';
import { renderSession } from './session-render.js';
import { featureStart, readStatus, statusPath, type Event, type Status } from './status.js';

export type Done = Extract<Event, { kind: 'pull' | 'failed' }>;

export interface Completed {
	readonly event: Done;
	// what this build's sessions cost: those after the Feature's previous outcome, up to this one
	readonly costUsd: number;
	// the ledger's built events for this build, counted over the same sessions; absent in a hand-made view
	readonly builtTickets?: number;
	// the same sessions' cost by stage and by model; absent in a hand-made view
	readonly cost?: BuildCost;
	// how each stage of this build went, from the same sessions; absent in a hand-made view
	readonly stages?: readonly BuildStage[];
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
	// the same cost by stage and by model; absent when nothing is building, and in a hand-made view
	readonly featureCost?: BuildCost;
	// how each stage of the current build is going; absent as the split is
	readonly featureStages?: readonly BuildStage[];
	// Tickets built on the local day
	readonly builtToday: number;
	// the last seven local days; absent in a hand-made view
	readonly week?: Week;
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

function sessionTail(root: string, status: Status | null, keep: number): string[] {
	const session = status?.doing.kind === 'building' ? status.doing.session : null;
	if (session === null) return [];
	const text = readEnd(join(logsPath(root), `${session}.jsonl`));
	if (text === null) return [];
	return renderSession(text.split('\n'))
		.map((line) => line.text)
		.slice(-keep);
}

const isDone = (event: Event): event is Done => event.kind === 'pull' || event.kind === 'failed';

// The draft pull request a Pull-check fix round's line belongs to: the Feature's latest `pull` event at or before it. A fix round runs after the run that opened the pull request has written its `pull` event, and writes no event of its own, so its line falls after that build's end; with no such event in `recent`, its build is not shown.
function pullOf(done: readonly Done[], line: Spent): Done | undefined {
	return done.findLast(
		(e) => e.kind === 'pull' && e.feature === line.feature && Date.parse(e.at) <= line.at
	);
}

// What a view shows, read from the repo root's .factory/ and nothing else.
export function readFactory(root: string, options: ReadOptions = {}): FactoryView {
	const status = readStatus(statusPath(root));
	const now = (options.now ?? (() => new Date()))();
	const alive = options.alive ?? pidAlive;
	const spent = spends(ledgerPath(root));
	const doing = status?.doing;
	const done = (status?.recent ?? []).filter(isDone);
	const never = stagesNeverRun(root);
	// a session recorded the moment the build starts is its own
	const lines =
		doing?.kind === 'building'
			? linesOnFeature(spent, doing.feature, Date.parse(featureStart(doing)) - 1, null)
			: null;
	const building = lines === null ? null : buildCost(lines);
	return {
		status,
		featureCostUsd: building?.usd ?? 0,
		...(building === null ? {} : { featureCost: building }),
		...(lines === null || doing?.kind !== 'building'
			? {}
			: {
					featureStages: buildStages(lines, {
						end: 'building',
						running: runningStage(doing),
						neverRun: never(doing.feature, null)
					})
				}),
		medianTicketMs: medianTicketMs(spent),
		builtToday: builtOn(ledgerPath(root), now),
		week: lastWeek({ sessions: spent, outcomes: done, handedBack: status?.handedBack ?? [] }, now),
		stopped: status !== null && !alive(status.pid),
		tail: sessionTail(root, status, options.tail ?? TAIL_LINES),
		completed: done.map((event, i) => {
			const before = done.slice(0, i).findLast((e) => e.feature === event.feature);
			const after = before === undefined ? null : Date.parse(before.at);
			const own = [
				...linesOnFeature(spent, event.feature, after, Date.parse(event.at)).filter(
					(s) => s.step !== 'pullChecks'
				),
				...spent.filter((s) => s.step === 'pullChecks' && pullOf(done, s) === event)
			].sort((a, b) => a.at - b.at);
			const cost = buildCost(own);
			return {
				event,
				costUsd: cost.usd,
				builtTickets: builtOnFeature(spent, event.feature, after, Date.parse(event.at)),
				cost,
				stages: buildStages(own, {
					end: event.kind,
					neverRun: never(event.feature, Date.parse(event.at))
				})
			};
		})
	};
}

// The stages the repo's factory.json never runs on a Feature's build that ended by `upTo` (null: the build in flight); none when factory.json is missing or does not read, so a stage the build has not got to is not reached.
// The build's Workflow is the one its Logbook's last build started names; with no such entry, the Steps are never run only when no Workflow has one.
function stagesNeverRun(
	root: string
): (feature: ItemId, upTo: number | null) => ReadonlySet<Stage> {
	let config: Config;
	try {
		config = loadConfig(root);
	} catch {
		return () => new Set();
	}
	const logbook = fileLogbook(root);
	const read = new Map<ItemId, readonly LogbookEntry[] | null>();
	return (feature, upTo) => {
		if (!read.has(feature)) read.set(feature, logbook.read(feature));
		const started = (read.get(feature) ?? []).findLast(
			(e) => e.kind === 'buildStarted' && (upTo === null || Date.parse(e.at) <= upTo)
		);
		return neverRun(config, started?.kind === 'buildStarted' ? started.workflow : undefined);
	};
}
