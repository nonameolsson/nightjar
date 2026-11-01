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

// The estimated dollars spent on the local day of `now`. A line that does not parse counts nothing.
export function spentOn(path: string, now: Date): number {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return 0;
	}
	const day = localDay(now);
	let sum = 0;
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		const entry = EntrySchema.safeParse(value);
		if (entry.success && localDay(new Date(entry.data.at)) === day) sum += entry.data.costUsd;
	}
	return sum;
}
