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
	outcome: z.string()
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

// The estimated dollars spent on each Feature over the whole ledger, by Feature id.
export function costByFeature(path: string): Map<string, number> {
	const costs = new Map<string, number>();
	for (const entry of readEntries(path)) {
		const feature = String(entry.feature);
		costs.set(feature, (costs.get(feature) ?? 0) + entry.costUsd);
	}
	return costs;
}
