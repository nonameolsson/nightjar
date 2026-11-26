// What the terminal view and the web page both say: clocks, money, ids and the run's state.
import type { BuildView, FactoryView } from './status-reader.js';
import { buildsOf } from './status.js';

export const two = (n: number) => String(n).padStart(2, '0');

// 1:12, or 30:00; the page runs this same function in the browser, so it uses nothing from outside but `two`
export const countdown = (ms: number) => {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${String(Math.floor(s / 60))}:${two(s % 60)}`;
};

// 12m 04s, or 1h 02m; run in the browser too, like countdown
export const elapsed = (ms: number) => {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s >= 3600) return `${String(Math.floor(s / 3600))}h ${two(Math.floor((s % 3600) / 60))}m`;
	return `${String(Math.floor(s / 60))}m ${two(s % 60)}s`;
};

const STEP_TEXT: Readonly<Record<string, string>> = {
	pullChecks: 'Pull-check fix',
	feedback: 'Feedback round',
	reviewRound: 'Review round'
};

// How a view names a build's step: the step as it is, but for a Pull-check fix round, a Feedback round and a Review round.
export const stepText = (step: string) => STEP_TEXT[step] ?? step;

// How a view names the kind of work a ledger line records.
export const KIND_TEXT: Readonly<Record<string, string>> = {
	build: 'build',
	fix: 'fix round',
	step: 'Step round',
	review: 'Review',
	pullChecks: 'Pull-check fix',
	feedback: 'Feedback round'
};

// The words for a Session tried again after a passing fault.
export const retryText = (retry: { readonly attempt: number; readonly of: number }) =>
	`retrying after a passing fault, try ${String(retry.attempt)} of ${String(retry.of)}`;

export const dollars = (usd: number) => `$${usd.toFixed(2)}`;

// 940, 12.3k or 1.2M tokens, with no `.0`
export const tokens = (n: number) => {
	const short = (v: number, unit: string) => `${v.toFixed(1).replace(/\.0$/, '')}${unit}`;
	if (n < 1000) return String(Math.round(n));
	if (n < 999_950) return short(n / 1000, 'k');
	return short(n / 1_000_000, 'M');
};

// A model's tokens in words: `1.2M in, 34k out, 9.8M cache read, 410k cache write`
export const tokensText = (m: {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
}) =>
	`${tokens(m.inputTokens)} in, ${tokens(m.outputTokens)} out, ${tokens(m.cacheReadTokens)} cache read, ${tokens(m.cacheWriteTokens)} cache write`;

// a numeric id reads as #42; another Tracker's (PROJ-123) as it is
export const idText = (id: string) => (/^\d+$/.test(id) ? `#${id}` : id);

export type RunState = 'off' | 'stopped' | 'idle' | 'watching' | 'paused';

// The pause the run is under, which builds in other Slots may still run through; null when it is not paused.
export function pauseOf(view: FactoryView): { why: string; until: string | null } | null {
	const status = view.status;
	if (status === null) return null;
	if (status.pause !== undefined) return status.pause;
	// an older file has no `pause`: its `doing` is the pause
	return status.doing.kind === 'paused' ? status.doing : null;
}

// Every busy Slot's build, oldest first. A hand-made view without `builds` gets the one build `doing` holds, with the view's own tail and cost, as an older file's reader would.
export function buildViews(view: FactoryView): readonly BuildView[] {
	if (view.builds !== undefined) return view.builds;
	const status = view.status;
	return status === null
		? []
		: buildsOf(status).map((build, i) => ({
				build,
				tail: i === 0 ? view.tail : [],
				costUsd: i === 0 ? view.featureCostUsd : 0,
				...(i === 0 && view.featureCost !== undefined ? { cost: view.featureCost } : {}),
				...(i === 0 && view.featureStages !== undefined ? { stages: view.featureStages } : {})
			}));
}

// A dead pid is stopped, whatever status.json says.
export function runState(view: FactoryView): RunState {
	if (view.status === null) return 'off';
	if (view.stopped) return 'stopped';
	if (pauseOf(view) !== null) return 'paused';
	switch (view.status.doing.kind) {
		case 'off':
			return 'off';
		case 'idle':
			return 'idle';
		case 'building':
			return 'watching';
		case 'paused':
			return 'paused';
	}
}

// With no run going, .factory/ holds no Queue, only history; the page's own read of the Tracker still has one.
export const running = (view: FactoryView) => {
	const state = runState(view);
	return state !== 'off' && state !== 'stopped';
};

// The Feature the next --watch poll waits for, or null when no Feature is being built under --watch.
export function pollAfter(view: FactoryView): string | null {
	const doing = view.status?.doing;
	return view.status?.watching === true &&
		doing?.kind === 'building' &&
		running(view) &&
		pauseOf(view) === null
		? idText(doing.feature)
		: null;
}
