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
import { lastWeek, type Week, type WeekSource } from './last-week.js';
import { everyLogbook } from './logbook-reader.js';
import { renderSession } from './session-render.js';
import { logbookMarks, STOPPED_BY_A_PERSON, type Mark } from './standing.js';
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
	// the same sessions' cost by stage and by model; absent in a hand-made view
	readonly cost?: BuildCost;
	// how each stage of this build went, from the same sessions; absent in a hand-made view
	readonly stages?: readonly BuildStage[];
}

// One busy Slot's build as a view shows it: its own Session tail and what its sessions cost.
export interface BuildView {
	readonly build: Building;
	// the last readable lines of this build's Session log, oldest first
	readonly tail: readonly string[];
	// what this build's sessions cost since it started
	readonly costUsd: number;
	// the same cost by stage and by model, and how each stage is going; absent in a hand-made view
	readonly cost?: BuildCost;
	readonly stages?: readonly BuildStage[];
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
	// each Feature's marks from its Logbook and the ledger, which with `completed` give its History; absent in a hand-made view
	readonly marks?: ReadonlyMap<ItemId, readonly Mark[]>;
	// what the oldest build's sessions cost since it started; 0 when nothing is building
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

function sessionTail(root: string, session: string | null, keep: number): string[] {
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

// How the Features ended and who was handed what, for the week: every Logbook's draft pull requests, faults and hand-overs to a person, which each keep a week and more, besides status.json's, which keep a fault that stopped the run before its Feature's Logbook could say so.
function weekEnds(
	books: ReadonlyMap<ItemId, readonly LogbookEntry[]>,
	done: readonly Done[],
	handedBack: WeekSource['handedBack']
): Pick<WeekSource, 'outcomes' | 'handedBack'> {
	const outcomes: WeekSource['outcomes'][number][] = [...done];
	const handed = [...handedBack];
	for (const entries of books.values())
		for (const e of entries) {
			if (e.kind === 'pullOpened') outcomes.push({ feature: e.feature, kind: 'pull', at: e.at });
			if (e.kind === 'fault') outcomes.push({ feature: e.feature, kind: 'failed', at: e.at });
			if (e.kind === 'handed') handed.push({ feature: e.feature, at: e.at });
		}
	return { outcomes, handedBack: handed };
}

// Each Feature's marks, for its Standing: its Logbook's, and the ledger's Sessions a person stopped, which a Logbook does not always record.
function marksOf(
	books: ReadonlyMap<ItemId, readonly LogbookEntry[]>,
	spent: readonly Spent[]
): Map<ItemId, Mark[]> {
	const marks = new Map<ItemId, Mark[]>();
	for (const [feature, entries] of books) marks.set(feature, logbookMarks(entries));
	for (const s of spent)
		if (s.outcome.includes(STOPPED_BY_A_PERSON))
			marks.set(s.feature, [
				...(marks.get(s.feature) ?? []),
				{ kind: 'stopped', at: new Date(s.at).toISOString() }
			]);
	return marks;
}

// What a view shows, read from the repo root's .factory/ and nothing else.
export function readFactory(root: string, options: ReadOptions = {}): FactoryView {
	const status = readStatus(statusPath(root));
	const now = (options.now ?? (() => new Date()))();
	const alive = options.alive ?? pidAlive;
	const spent = spends(ledgerPath(root));
	const keep = options.tail ?? TAIL_LINES;
	// an older file's `doing` is its one build
	const busy = status === null ? [] : buildsOf(status);
	const never = stagesNeverRun(root);
	const builds = busy.map((build): BuildView => {
		// a session recorded the moment the build starts is its own
		const lines = linesOnFeature(spent, build.feature, Date.parse(featureStart(build)) - 1, null);
		const cost = buildCost(lines);
		return {
			build,
			tail: sessionTail(root, build.session, keep),
			costUsd: cost.usd,
			cost,
			stages: buildStages(lines, {
				end: 'building',
				running: runningStage(build),
				neverRun: never(build.feature, null)
			})
		};
	});
	const done = (status?.recent ?? []).filter(isDone);
	// the oldest build's, which an older reader follows
	const oldest = builds[0];
	const books = everyLogbook(root);
	return {
		status,
		builds,
		marks: marksOf(books, spent),
		featureCostUsd: oldest?.costUsd ?? 0,
		...(oldest?.cost === undefined ? {} : { featureCost: oldest.cost }),
		...(oldest?.stages === undefined ? {} : { featureStages: oldest.stages }),
		medianTicketMs: medianTicketMs(spent),
		builtToday: builtOn(ledgerPath(root), now),
		week: lastWeek({ sessions: spent, ...weekEnds(books, done, status?.handedBack ?? []) }, now),
		stopped: status !== null && !alive(status.pid),
		tail: builds[0]?.tail ?? [],
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
