// The Logbook (GLOSSARY.md): each decision Nightjar made on a Feature between its Sessions, one append-only file per Feature under .factory/logbook/. The Sessions themselves stay in the ledger; `logbook-reader.ts` joins the two.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SIGNALS } from './signals.js';
import type { ItemId } from './tracker.js';

const Issue = z.object({ file: z.string(), line: z.number().optional(), problem: z.string() });

// What Nightjar decided, by kind; each kind's own fields beside it.
const DecisionSchema = z.discriminatedUnion('kind', [
	// the build began: by the Go, or by a request for changes on its pull request, whose id is `asked`
	z.object({
		kind: z.literal('buildStarted'),
		by: z.enum(['go', 'feedback']),
		asked: z.string().optional(),
		branch: z.string(),
		// the Feature's Workflow, null with none
		workflow: z.string().nullable()
	}),
	// factory.json's setup command ran in a new worktree
	z.object({ kind: z.literal('setup'), command: z.string(), ok: z.boolean() }),
	z.object({ kind: z.literal('ticketStarted') }),
	// the Ticket's one commit on the branch
	z.object({ kind: z.literal('ticketBuilt'), commit: z.string() }),
	// the check failed, and `report`, the gate report as handed over, starts fix round `round` of `rounds`
	z.object({
		kind: z.literal('checkRed'),
		report: z.string(),
		round: z.number(),
		rounds: z.number()
	}),
	// the work was not kept: on the attempt branch `branch`, or on none when it left nothing
	z.object({ kind: z.literal('thrownAway'), branch: z.string().nullable(), why: z.string() }),
	// how one Step of the Workflow ended: done, ran every round with its condition unmet, or not done
	z.object({
		kind: z.literal('stepVerdict'),
		workflow: z.string(),
		step: z.string(),
		verdict: z.enum(['done', 'unmet', 'undone']),
		why: z.string().optional(),
		rounds: z.number().optional(),
		left: z.array(z.string())
	}),
	// the Review's verdict and issues; a null verdict is a Review that did not finish
	z.object({
		kind: z.literal('review'),
		verdict: z.enum(['approve', 'changes']).nullable(),
		summary: z.string().nullable(),
		issues: z.array(Issue)
	}),
	// a Signal put on (`on`) or taken off the Feature, or off the entry's Ticket
	z.object({ kind: z.literal('signal'), signal: z.enum(SIGNALS), on: z.boolean() }),
	// the Feature's draft pull request: a new one, or the branch's open one with a new body
	z.object({ kind: z.literal('pullOpened'), url: z.string(), created: z.boolean() }),
	z.object({ kind: z.literal('paused'), why: z.string() }),
	// the Feature, or the entry's Ticket, handed to a person with needs info or needs a person
	z.object({ kind: z.literal('handed'), to: z.enum(['needsInfo', 'human']), why: z.string() })
]);

export type Decision = z.infer<typeof DecisionSchema>;

// Where an entry belongs: the Ticket and the Session it is about, where it has them.
export interface Place {
	readonly ticket?: ItemId;
	readonly session?: string;
}

// One line of a Feature's Logbook file.
export type LogbookEntry = Decision & Place & { readonly at: string; readonly feature: ItemId };

const EntrySchema = DecisionSchema.and(
	z.object({
		at: z.string(),
		// a number in a hand-written line
		feature: z.union([z.string(), z.int()]).transform(String),
		ticket: z.union([z.string(), z.int()]).transform(String).optional(),
		session: z.string().optional()
	})
);

export interface Logbook {
	// adds one entry to its Feature's Logbook
	write(entry: LogbookEntry): void;
	// the Feature's entries, oldest first; null when the Feature has no Logbook at all
	read(feature: ItemId): readonly LogbookEntry[] | null;
}

export const logbookFolder = (root: string) => join(root, '.factory', 'logbook');

// One file per Feature; an id is made safe as a file name, so a key like `PROJ-1` or `a/b` stays one file.
export const logbookPath = (root: string, feature: ItemId) =>
	join(logbookFolder(root), `${encodeURIComponent(feature)}.jsonl`);

// The entries of a Logbook file's text that parse; a line that does not is skipped.
export function parseLogbook(text: string): LogbookEntry[] {
	const entries: LogbookEntry[] = [];
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		const parsed = EntrySchema.safeParse(value);
		if (parsed.success) entries.push(parsed.data);
	}
	return entries;
}

// The Logbook over the files under .factory/logbook/, written whether or not a terminal is attached.
export function fileLogbook(root: string): Logbook {
	return {
		write: (entry) => {
			const path = logbookPath(root, entry.feature);
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(entry)}\n`);
		},
		read: (feature) => {
			let text: string;
			try {
				text = readFileSync(logbookPath(root, feature), 'utf8');
			} catch {
				return null;
			}
			return parseLogbook(text);
		}
	};
}

// Writes one Feature's entries, dated by `now`.
export type Note = (entry: Decision & Place) => void;

export const noteFor =
	(logbook: Logbook, feature: ItemId, now: () => Date): Note =>
	(entry) => {
		logbook.write({ at: now().toISOString(), feature, ...entry });
	};
