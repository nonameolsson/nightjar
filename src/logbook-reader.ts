// The one reader of a Feature's Logbook, for the page and the CLI: its decisions from .factory/logbook/, joined with its Sessions from the ledger, each with its transcript's path.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logsPath } from './coding-agent.js';
import { ledgerPath, readEntries } from './ledger.js';
import { fileLogbook, logbookFolder, type LogbookEntry } from './logbook.js';
import { renderSession, type SessionLine } from './session-render.js';
import type { Entry } from './spend.js';
import type { ItemId } from './tracker.js';

// One Session the ledger recorded for the Feature.
export interface LoggedSession {
	readonly id: string;
	// when it ended
	readonly at: string;
	// the work it did: a Ticket's build, a fix round, a Step round, the Review, a Pull-check fix or a Feedback round
	readonly kind: Entry['step'];
	readonly ticket: ItemId | null;
	readonly outcome: string;
	readonly costUsd: number;
	// absent in a ledger line written before durations were
	readonly durationMs?: number;
	// .factory/logs/<session>.jsonl, which a resumed Session shares with the one it resumes
	readonly transcript: string;
}

export type LogbookItem =
	| { readonly kind: 'session'; readonly session: LoggedSession }
	| { readonly kind: 'decision'; readonly entry: LogbookEntry };

export interface LogbookView {
	readonly feature: ItemId;
	// false when the Feature has no Logbook file, as one built before it was kept: its Sessions only, and no decision recorded
	readonly recorded: boolean;
	// the Sessions and the decisions, in the order they happened
	readonly items: readonly LogbookItem[];
}

const sessionOf = (root: string, e: Entry): LoggedSession => ({
	id: e.session,
	at: e.at,
	kind: e.step,
	ticket: e.ticket,
	outcome: e.outcome,
	costUsd: e.costUsd,
	...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }),
	transcript: join(logsPath(root), `${e.session}.jsonl`)
});

// Both lists are oldest first. At the same moment a decision comes before a Session, unless it is about that Session, as a Review's verdict or a red check after it is.
function merge(
	decisions: readonly LogbookEntry[],
	sessions: readonly LoggedSession[]
): LogbookItem[] {
	const items: LogbookItem[] = [];
	let d = 0;
	let s = 0;
	while (d < decisions.length || s < sessions.length) {
		const entry = decisions[d];
		const session = sessions[s];
		const sessionFirst =
			session !== undefined &&
			(entry === undefined ||
				Date.parse(session.at) < Date.parse(entry.at) ||
				(Date.parse(session.at) === Date.parse(entry.at) && entry.session === session.id));
		if (sessionFirst) {
			items.push({ kind: 'session', session });
			s += 1;
		} else if (entry !== undefined) {
			items.push({ kind: 'decision', entry });
			d += 1;
		}
	}
	return items;
}

// What a Session id looks like: letters, digits, `-` and `_`, as Claude Code's UUIDs are. Anything else is never a file name to open.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isSessionId = (id: string) => SESSION_ID.test(id);

// A ledger line for a Session, with the Feature it was spent on.
export interface SessionRun extends LoggedSession {
	readonly feature: ItemId;
}

// One Session, whole: what the ledger says of it and its transcript as the views show it.
export interface SessionView {
	readonly id: string;
	// the ledger's lines for it, oldest first; a fix round resumes the Session it fixes, so a Session may have several, and none when the ledger has no line for it
	readonly runs: readonly SessionRun[];
	// the Coding agent's text, each tool call, and each tool result
	readonly lines: readonly SessionLine[];
}

// A Session read from the repo root's .factory/ and nothing else; null for an id that is not a Session id or has no transcript.
export function readSession(root: string, id: string): SessionView | null {
	if (!isSessionId(id)) return null;
	let text: string;
	try {
		text = readFileSync(join(logsPath(root), `${id}.jsonl`), 'utf8');
	} catch {
		return null;
	}
	return {
		id,
		runs: readEntries(ledgerPath(root))
			.filter((e) => e.session === id)
			.map((e) => ({ ...sessionOf(root, e), feature: e.feature })),
		lines: renderSession(text.split('\n'), 'full')
	};
}

// A Feature's Logbook, read from the repo root's .factory/ and nothing else.
export function readLogbook(root: string, feature: ItemId): LogbookView {
	const decisions = fileLogbook(root).read(feature);
	const sessions = readEntries(ledgerPath(root))
		.filter((e) => e.feature === feature)
		.map((e) => sessionOf(root, e));
	return {
		feature,
		recorded: decisions !== null,
		items: merge(decisions ?? [], sessions)
	};
}

// A Session's transcript in the summary rendering: the Coding agent's text and one line per tool call; none when it has no transcript on this machine.
export function sessionSummary(session: LoggedSession): SessionLine[] {
	try {
		return renderSession(readFileSync(session.transcript, 'utf8').split('\n'), 'summary');
	} catch {
		return [];
	}
}

// One Feature that has a Logbook file or ledger lines, as a list of every Logbook shows it.
export interface LogbookListing {
	readonly feature: ItemId;
	// the time of its latest entry or Session
	readonly lastAt: string;
	readonly sessions: number;
	readonly costUsd: number;
	// false with ledger lines and no Logbook file
	readonly recorded: boolean;
}

// Every Feature with a Logbook file or ledger lines, the one touched last first.
export function listLogbooks(root: string): LogbookListing[] {
	const found = new Map<ItemId, Omit<LogbookListing, 'feature'>>();
	const later = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);
	let files: string[];
	try {
		files = readdirSync(logbookFolder(root));
	} catch {
		files = [];
	}
	const book = fileLogbook(root);
	for (const name of files) {
		if (!name.endsWith('.jsonl')) continue;
		let feature: string;
		try {
			feature = decodeURIComponent(name.slice(0, -'.jsonl'.length));
		} catch {
			continue;
		}
		const entries = book.read(feature) ?? [];
		const last = entries.reduce((a, e) => later(a, e.at), entries[0]?.at ?? '');
		if (last === '') continue;
		found.set(feature, { lastAt: last, sessions: 0, costUsd: 0, recorded: true });
	}
	for (const e of readEntries(ledgerPath(root))) {
		const was = found.get(e.feature);
		found.set(e.feature, {
			lastAt: was === undefined ? e.at : later(was.lastAt, e.at),
			sessions: (was?.sessions ?? 0) + 1,
			costUsd: (was?.costUsd ?? 0) + e.costUsd,
			recorded: was?.recorded ?? false
		});
	}
	return [...found]
		.map(([feature, f]) => ({ feature, ...f }))
		.sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0));
}
