// The one reader of a Feature's Logbook, for the page and the CLI: its decisions from .factory/logbook/, joined with its Sessions from the ledger, each with its transcript's path.
import { join } from 'node:path';
import { logsPath } from './coding-agent.js';
import { ledgerPath, readEntries } from './ledger.js';
import { fileLogbook, type LogbookEntry } from './logbook.js';
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
