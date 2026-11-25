// The Spend module: records each Session's cost and answers whether the day is over and whether work may spend more.

// One Session's line in the ledger.
export interface Entry {
	readonly at: string;
	readonly repo: string;
	readonly feature: string;
	readonly ticket: string | null;
	readonly branch: string;
	// 'pullChecks' is a Pull-check fix round, 'feedback' a Feedback round and 'reviewRound' a Review round, each with its check's own fix rounds
	readonly step: 'build' | 'fix' | 'review' | 'step' | 'pullChecks' | 'feedback' | 'reviewRound';
	readonly session: string;
	readonly costUsd: number;
	readonly outcome: string;
	// why a failed session failed; absent for any other outcome and in older lines
	readonly failure?: 'passing' | 'budget' | 'lasting';
	// how long the session ran, in milliseconds; older lines lack it
	readonly durationMs?: number;
}

// A ledger line as a piece of work gives it: the run adds where and when.
export type LogEntry = Omit<Entry, 'at' | 'repo' | 'feature' | 'branch'>;

// What a piece of work with a cap may still spend.
export interface Allowance {
	// the dollars left of its cap, which the next Session gets as its budget
	readonly usd: number;
	// whether that is enough for another Session
	readonly enough: boolean;
}

// The cap of a Session that is running, held as spent until the Session ends.
export interface Reservation {
	// gives the cap back, for a Session that spent nothing the ledger will show. Safe to call twice.
	release(): void;
	// gives the cap back and holds what the Session `session` actually spent in its place, until its ledger line is recorded: the line is written after the Session returns, and a Session waiting for room must not start on dollars spent but not yet in the ledger. Safe to call twice.
	settle(session: string, usd: number): void;
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
	// holds `usd`, the cap of a Session about to start, as `reserve` does, when it fits under `dailyUsd` beside today's spend and the caps of the Sessions running; else why it does not, and holds nothing. With no other Session running it always holds, as with one Slot. The check and the hold are one step, so two Slots cannot both pass it on the same dollars.
	hold(usd: number, now: Date, dailyUsd: number): Reservation | string;
	// resolves once a held cap is given back, at once when none is held, or when `signal` aborts: a Session that `hold` turned away waits on it to try again
	freed(signal?: AbortSignal): Promise<void>;
	// why the day is over, once today's spend has reached `dailyUsd`; else null. The caps held do not count: a Session they leave no room for waits for one to be given back, and does not pause the run.
	dayOver(now: Date, dailyUsd: number): string | null;
	// what a piece of work that has spent `spent` of its `cap` may still spend; the day's limit is not its business: a Session the other Slots leave no room for waits where it starts
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
	// the caps of the Sessions running, each held until its Session ends
	const holds = new Set<{ readonly usd: number }>();
	// what Sessions that ended spent, until their ledger lines are recorded
	const unrecorded: { readonly session: string; readonly usd: number }[] = [];
	const reserved = () => {
		let sum = 0;
		for (const hold of holds) sum += hold.usd;
		for (const spent of unrecorded) sum += spent.usd;
		return sum;
	};
	// the Sessions waiting for a cap to be given back
	const waiting = new Set<() => void>();
	const wakeAll = () => {
		const woken = [...waiting];
		waiting.clear();
		for (const wake of woken) wake();
	};
	const reserve = (usd: number): Reservation => {
		const hold = { usd };
		holds.add(hold);
		return {
			release: () => {
				if (holds.delete(hold)) wakeAll();
			},
			settle: (session, spent) => {
				if (!holds.delete(hold)) return;
				unrecorded.push({ session, usd: spent });
				wakeAll();
			}
		};
	};
	const freed = (signal?: AbortSignal): Promise<void> => {
		if (holds.size === 0 || signal?.aborted === true) return Promise.resolve();
		return new Promise((resolve) => {
			const wake = () => {
				waiting.delete(wake);
				signal?.removeEventListener('abort', wake);
				resolve();
			};
			waiting.add(wake);
			signal?.addEventListener('abort', wake, { once: true });
		});
	};
	// why a Session with a `cap` may not start beside the ones running, or null
	const crowded = (now: Date, dailyUsd: number, cap: number): string | null => {
		const others = reserved();
		const spent = today(now);
		const committed = spent + others;
		if (committed + cap <= dailyUsd) return null;
		const counted = `today's estimated spend, ${dollars(spent)}, plus ${dollars(others)} held for the Sessions running in other Slots`;
		return committed >= dailyUsd
			? `${counted}, reached the daily limit of ${dollars(dailyUsd)}`
			: `${counted} and ${dollars(cap)} for this Session would pass the daily limit of ${dollars(dailyUsd)}`;
	};
	return {
		record: (entry) => {
			store.append(entry);
			const at = unrecorded.findIndex((u) => u.session === entry.session);
			if (at >= 0) unrecorded.splice(at, 1);
		},
		entries: () => store.read(),
		today,
		reserve,
		hold: (usd, now, dailyUsd) => {
			// with no other Session running the day is checked only where work starts, so the pause comes as it does with one Slot
			if (holds.size === 0) return reserve(usd);
			return crowded(now, dailyUsd, usd) ?? reserve(usd);
		},
		freed,
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
