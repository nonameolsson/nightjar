// .factory/runs.jsonl: one line per session with its cost, from which the day's spend is added up.
// The file is the Spend module's file adapter; the build loop reaches it only through `Spend`.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { localDay, spendOver, type Entry, type Spend } from './spend.js';

export type { Entry };

export const ledgerPath = (root: string) => join(root, '.factory', 'runs.jsonl');

const EntrySchema = z.looseObject({
	at: z.string(),
	repo: z.string(),
	// a number in a line written before ids were strings
	feature: z.union([z.string(), z.int()]),
	ticket: z.union([z.string(), z.int()]).nullable(),
	branch: z.string(),
	step: z.enum(['build', 'fix', 'review', 'step']),
	session: z.string(),
	costUsd: z.number(),
	outcome: z.string()
});

export function record(path: string, entry: Entry): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// The lines of the ledger that parse; a line that does not, or the missing file, gives none.
export function readEntries(path: string): Entry[] {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return [];
	}
	const entries: Entry[] = [];
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		const parsed = EntrySchema.safeParse(value);
		if (parsed.success) {
			const { feature, ticket } = parsed.data;
			entries.push({
				...parsed.data,
				feature: String(feature),
				ticket: ticket === null ? null : String(ticket)
			});
		}
	}
	return entries;
}

// The Spend module over the ledger file.
export const fileSpend = (path: string): Spend =>
	spendOver({ append: (entry) => record(path, entry), read: () => readEntries(path) });

// How many Tickets were built on the local day of `now`.
export function builtOn(path: string, now: Date): number {
	const day = localDay(now);
	return readEntries(path).filter(
		(e) => e.step === 'build' && e.outcome === 'built' && localDay(new Date(e.at)) === day
	).length;
}

// The repo the ledger's latest line names, or null with no line.
export function lastRepo(path: string): string | null {
	return readEntries(path).at(-1)?.repo ?? null;
}

export interface Spent {
	readonly feature: string;
	readonly at: number;
	readonly costUsd: number;
}

// Each session's cost, by Feature id and the time it was recorded.
export function spends(path: string): Spent[] {
	return readEntries(path).map((e) => ({
		feature: e.feature,
		at: Date.parse(e.at),
		costUsd: e.costUsd
	}));
}

// The dollars spent on a Feature after `after` (exclusive) and up to `until` (inclusive), either open.
export function spentOnFeature(
	all: readonly Spent[],
	feature: string,
	after: number | null,
	until: number | null
): number {
	let sum = 0;
	for (const s of all) {
		if (s.feature !== feature) continue;
		if ((after === null || s.at > after) && (until === null || s.at <= until)) sum += s.costUsd;
	}
	return sum;
}
