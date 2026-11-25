// The Spend module: records each Session's cost and answers whether the day is over and whether work may spend more.

// One Session's line in the ledger.
export interface Entry {
	readonly at: string;
	readonly repo: string;
	readonly feature: string;
	readonly ticket: string | null;
	readonly branch: string;
	// 'pullChecks' is a Pull-check fix round and 'feedback' a Feedback round, each with its check's own fix rounds
	readonly step: 'build' | 'fix' | 'review' | 'step' | 'pullChecks' | 'feedback';
	readonly session: string;
	readonly costUsd: number;
	readonly outcome: string;
	// why a failed session failed; absent for any other outcome and in older lines
	readonly failure?: 'passing' | 'budget' | 'lasting';
	// how long the session ran, in milliseconds; older lines lack it
	readonly durationMs?: number;
}

// What a piece of work with a cap may still spend.
export interface Allowance {
	// the dollars left of its cap, which the next Session gets as its budget
	readonly usd: number;
	// whether that is enough for another Session
	readonly enough: boolean;
}

// The cap of a Session that is running, held as spent until the Session ends.
export interface Reservation {
	// gives the cap back; what the Session actually spent is in the ledger by then. Safe to call twice.
	release(): void;
}

export interface Spend {
	// adds one Session's line to the ledger
	record(entry: Entry): void;
	// every line recorded, oldest first
	entries(): readonly Entry[];
	// the estimated dollars spent on the local day of `now`
	today(now: Date): number;
	// holds `usd`, the cap of a Session that starts now, as spent until the returned Reservation is released; each running Session holds one
	reserve(usd: number): Reservation;
	// why a Session with a `cap` may not start, once today's spend plus the caps of the Sessions running reached `dailyUsd`; else null. With another Session running, the Session's own `cap` must fit under `dailyUsd` as well; with none, only the spend so far counts, as with one Slot.
	dayOver(now: Date, dailyUsd: number, cap?: number): string | null;
	// what a piece of work that has spent `spent` of its `cap` may still spend; with another Session running, only what fits under `dailyUsd` beside today's spend and the caps of the Sessions running
	allowance(cap: number, spent: number, now: Date, dailyUsd: number): Allowance;
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
	// the caps of the Sessions running, each held until its Session ends
	const holds = new Set<{ readonly usd: number }>();
	const reserved = () => {
		let sum = 0;
		for (const hold of holds) sum += hold.usd;
		return sum;
	};
	return {
		record: (entry) => {
			store.append(entry);
		},
		entries: () => store.read(),
		today,
		reserve: (usd) => {
			const hold = { usd };
			holds.add(hold);
			return {
				release: () => {
					holds.delete(hold);
				}
			};
		},
		dayOver: (now, dailyUsd, cap = 0) => {
			const others = reserved();
			const spent = today(now);
			const committed = spent + others;
			const reached = committed >= dailyUsd;
			if (!reached && !(others > 0 && committed + cap > dailyUsd)) return null;
			if (others === 0) {
				return `today's estimated spend, ${dollars(spent)}, reached the daily limit of ${dollars(dailyUsd)}`;
			}
			const counted = `today's estimated spend, ${dollars(spent)}, plus ${dollars(others)} held for the Sessions running in other Slots`;
			return reached
				? `${counted}, reached the daily limit of ${dollars(dailyUsd)}`
				: `${counted} and ${dollars(cap)} for this Session would pass the daily limit of ${dollars(dailyUsd)}`;
		},
		allowance: (cap, spent, now, dailyUsd) => {
			const usd = cap - spent;
			// with no other Session running the day is checked only where work starts, so the pause comes as it does with one Slot
			const others = reserved();
			const fits = others === 0 || today(now) + others + usd <= dailyUsd;
			return { usd, enough: usd >= MIN_USD && fits };
		}
	};
}
