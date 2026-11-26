// The Spend module: records each Session's cost and answers whether the day is over and whether work may spend more.

// The kinds of a build's work: 'pullChecks' is a Pull-check fix round, 'feedback' a Feedback round and 'reviewRound' a Review round, each with its check's own fix rounds.
type BuildStep = 'build' | 'fix' | 'review' | 'step' | 'pullChecks' | 'feedback' | 'reviewRound';

// What one model did in a Session: its tokens and its share of the Session's dollars.
export interface ModelUsage {
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly costUsd: number;
}

// The `models` a ledger line gets from a Session's outcome, when the Session had them.
export const modelsOf = (from: {
	readonly models?: readonly ModelUsage[] | undefined;
}): { readonly models?: readonly ModelUsage[] } =>
	from.models === undefined ? {} : { models: from.models };

// One Session's line in the ledger.
export interface Entry {
	readonly at: string;
	readonly repo: string;
	readonly feature: string;
	readonly ticket: string | null;
	readonly branch: string;
	// 'retro' is a Retro, which works on no Feature, so its feature and branch are empty
	readonly step: BuildStep | 'retro';
	readonly session: string;
	readonly costUsd: number;
	readonly outcome: string;
	// why a failed session failed; absent for any other outcome and in older lines
	readonly failure?: 'passing' | 'budget' | 'lasting';
	// how long the session ran, in milliseconds; older lines lack it
	readonly durationMs?: number;
	// the models the session ran on, one entry each; older lines lack it, and so does a session that reported none
	readonly models?: readonly ModelUsage[];
}

// A ledger line as a piece of a build's work gives it: the run adds where and when. A Retro is never part of a build.
export interface LogEntry extends Omit<Entry, 'at' | 'repo' | 'feature' | 'branch' | 'step'> {
	readonly step: BuildStep;
}

// What a piece of work with a cap may still spend.
export interface Allowance {
	// the dollars left of its cap, which the next Session gets as its budget
	readonly usd: number;
	// whether that is enough for another Session
	readonly enough: boolean;
}

export interface Spend {
	// adds one Session's line to the ledger
	record(entry: Entry): void;
	// every line recorded, oldest first
	entries(): readonly Entry[];
	// the estimated dollars spent on the local day of `now`
	today(now: Date): number;
	// why the day is over, once today's spend has reached `dailyUsd`; else null
	dayOver(now: Date, dailyUsd: number): string | null;
	// what a piece of work that has spent `spent` of its `cap` may still spend
	allowance(cap: number, spent: number): Allowance;
}

// Where the lines are kept: the file, or memory for a spec.
export interface SpendStore {
	append(entry: Entry): void;
	read(): readonly Entry[];
}

// Less than this is too little for another Session.
const MIN_USD = 1;

const dollars = (n: number) => `$${n.toFixed(2)}`;

export const localDay = (d: Date) =>
	`${String(d.getFullYear())}-${String(d.getMonth() + 1)}-${String(d.getDate())}`;

export function spendOver(store: SpendStore): Spend {
	const today = (now: Date) => {
		const day = localDay(now);
		let sum = 0;
		for (const entry of store.read()) {
			if (localDay(new Date(entry.at)) === day) sum += entry.costUsd;
		}
		return sum;
	};
	return {
		record: (entry) => {
			store.append(entry);
		},
		entries: () => store.read(),
		today,
		dayOver: (now, dailyUsd) => {
			const spent = today(now);
			return spent >= dailyUsd
				? `today's estimated spend, ${dollars(spent)}, reached the daily limit of ${dollars(dailyUsd)}`
				: null;
		},
		allowance: (cap, spent) => {
			const usd = cap - spent;
			return { usd, enough: usd >= MIN_USD };
		}
	};
}
