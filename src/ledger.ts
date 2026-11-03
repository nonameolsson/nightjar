// .factory/runs.jsonl: one line per session with its cost, from which the day's spend is added up.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

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
	outcome: z.string(),
	// older lines lack it
	durationMs: z.number().optional()
});

export interface Entry {
	readonly at: string;
	readonly repo: string;
	readonly feature: string;
	readonly ticket: string | null;
	readonly branch: string;
	readonly step: 'build' | 'fix' | 'review' | 'step';
	readonly session: string;
	readonly costUsd: number;
	readonly outcome: string;
	// how long the session ran, in milliseconds
	readonly durationMs?: number;
}

export function record(path: string, entry: Entry): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

const localDay = (d: Date) =>
	`${String(d.getFullYear())}-${String(d.getMonth() + 1)}-${String(d.getDate())}`;

// The lines of the ledger that parse; a line that does not, or the missing file, gives none.
function readEntries(path: string) {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return [];
	}
	const entries: z.infer<typeof EntrySchema>[] = [];
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		const entry = EntrySchema.safeParse(value);
		if (entry.success) entries.push(entry.data);
	}
	return entries;
}

// The estimated dollars spent on the local day of `now`. A line that does not parse counts nothing.
export function spentOn(path: string, now: Date): number {
	const day = localDay(now);
	let sum = 0;
	for (const entry of readEntries(path)) {
		if (localDay(new Date(entry.at)) === day) sum += entry.costUsd;
	}
	return sum;
}

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

export interface Spend {
	readonly feature: string;
	readonly at: number;
	readonly costUsd: number;
	// the session built a Ticket
	readonly built: boolean;
}

// Each session's cost, by Feature id and the time it was recorded.
export function spends(path: string): Spend[] {
	return readEntries(path).map((e) => ({
		feature: String(e.feature),
		at: Date.parse(e.at),
		costUsd: e.costUsd,
		built: e.step === 'build' && e.outcome === 'built'
	}));
}

// How many Tickets of a Feature were built after `after` (exclusive) and up to `until` (inclusive), either open.
export function builtOnFeature(
	all: readonly Spend[],
	feature: string,
	after: number | null,
	until: number | null
): number {
	let n = 0;
	for (const s of all) {
		if (!s.built || s.feature !== feature) continue;
		if ((after === null || s.at > after) && (until === null || s.at <= until)) n += 1;
	}
	return n;
}

// The dollars spent on a Feature after `after` (exclusive) and up to `until` (inclusive), either open.
export function spentOnFeature(
	all: readonly Spend[],
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
