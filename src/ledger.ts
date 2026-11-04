// .factory/runs.jsonl, the Spend module's file adapter: one line per session with its cost.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { localDay, spendOver, type Entry, type Spend } from './spend.js';

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
	outcome: z.string(),
	// older lines lack it
	durationMs: z.number().optional()
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
	readonly branch: string;
	// the Ticket the session worked on; null for one over the whole Feature, such as the review
	readonly ticket: string | null;
	readonly at: number;
	readonly costUsd: number;
	// the session built a Ticket
	readonly built: boolean;
	// how long the session ran; absent in an older line
	readonly durationMs?: number;
}

// The median time a built Ticket took, or null with none recorded: its build, fix and Step sessions,
// plus an even share of its Feature's sessions over all Tickets (the review, Steps after all Tickets).
export function medianTicketMs(all: readonly Spent[]): number | null {
	const key = (s: Spent) => `${s.feature}\n${s.branch}`;
	const ms = (s: Spent) => s.durationMs ?? 0;
	const timed = new Set(
		all
			.filter((s) => s.built && s.durationMs !== undefined)
			.map((s) => `${key(s)}\n${String(s.ticket)}`)
	);
	const builtIn = new Map<string, number>();
	const shared = new Map<string, number>();
	const own = new Map<string, number>();
	for (const s of all) {
		if (s.built) builtIn.set(key(s), (builtIn.get(key(s)) ?? 0) + 1);
		if (s.ticket === null) shared.set(key(s), (shared.get(key(s)) ?? 0) + ms(s));
		else {
			const t = `${key(s)}\n${s.ticket}`;
			if (timed.has(t)) own.set(t, (own.get(t) ?? 0) + ms(s));
		}
	}
	const sorted = [...own]
		.map(([t, took]) => {
			const k = t.slice(0, t.lastIndexOf('\n'));
			return took + (shared.get(k) ?? 0) / (builtIn.get(k) ?? 1);
		})
		.sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

// Each session's cost, by Feature id and the time it was recorded.
export function spends(path: string): Spent[] {
	return readEntries(path).map((e) => ({
		feature: e.feature,
		branch: e.branch,
		ticket: e.ticket,
		at: Date.parse(e.at),
		costUsd: e.costUsd,
		built: e.step === 'build' && e.outcome === 'built',
		...(e.durationMs === undefined ? {} : { durationMs: e.durationMs })
	}));
}

// How many Tickets of a Feature were built after `after` (exclusive) and up to `until` (inclusive), either open.
export function builtOnFeature(
	all: readonly Spent[],
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
