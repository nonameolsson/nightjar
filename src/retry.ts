// Retries a Session that failed for a passing reason: the worktree goes back to the commit before the try, and a new Session starts after a wait.
import type { Failure } from './session.js';

// The wait before the second try and before the third.
export const RETRY_WAITS_MS = [30_000, 120_000] as const;

// How many tries a Session gets in all.
export const TRIES = RETRY_WAITS_MS.length + 1;

interface Tried {
	readonly kind: string;
	readonly sessionId: string;
	readonly costUsd: number;
}

export type Failed = Tried & {
	readonly kind: 'failed';
	readonly why: string;
	readonly failure: Failure;
};

const passing = (r: Tried): r is Failed =>
	r.kind === 'failed' && (r as Partial<Failed>).failure === 'passing';

export interface Retries<R extends Tried> {
	// one Session: its budget, and which try it is (1 to TRIES)
	readonly run: (budgetUsd: number, attempt: number) => Promise<R>;
	// the most the Session may spend in all; a retry that would pass it is not started
	readonly budgetUsd: number;
	readonly enough: (budgetUsd: number) => boolean;
	// puts the worktree back to the commit before the first try
	readonly reset: () => Promise<void>;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly signal?: AbortSignal;
	// a try that failed and is followed by another gets its own line in the ledger
	readonly record: (failed: R & Failed, attempt: number) => void;
	// the next try is about to start, after its wait
	readonly retrying: (attempt: number, why: string) => void;
}

export interface Retried<R extends Tried> {
	readonly outcome: R;
	// what the tries before the last one cost; the last one's cost is in `outcome`
	readonly earlierUsd: number;
}

// Runs the Session, and again after each wait while it fails as `passing`. After the last try the failure is the outcome, naming every try's reason.
export async function retryPassing<R extends Tried>(r: Retries<R>): Promise<Retried<R>> {
	const whys: string[] = [];
	let earlierUsd = 0;
	for (let attempt = 1; ; attempt += 1) {
		const got = await r.run(r.budgetUsd - earlierUsd, attempt);
		if (!passing(got)) return { outcome: got, earlierUsd };
		whys.push(got.why);
		const wait = RETRY_WAITS_MS[attempt - 1];
		const left = r.budgetUsd - earlierUsd - got.costUsd;
		if (wait === undefined || !r.enough(left)) {
			const why =
				attempt === 1 ? got.why : whys.map((w, i) => `try ${String(i + 1)}: ${w}`).join('; ');
			return { outcome: { ...got, why }, earlierUsd };
		}
		r.record(got, attempt);
		earlierUsd += got.costUsd;
		r.retrying(attempt + 1, got.why);
		await r.reset();
		await r.sleep(wait, r.signal);
		if (r.signal?.aborted === true) {
			return {
				outcome: { kind: 'aborted', sessionId: got.sessionId, costUsd: 0 } as unknown as R,
				earlierUsd
			};
		}
	}
}
