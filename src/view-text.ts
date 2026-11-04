// What the terminal view and the web page both say: clocks, money, ids and the run's state.
import type { FactoryView } from './status-reader.js';

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

// How a view names a build's step: the step as it is, but for a Pull-check fix round.
export const stepText = (step: string) => (step === 'pullChecks' ? 'Pull-check fix' : step);

export const dollars = (usd: number) => `$${usd.toFixed(2)}`;

// a numeric id reads as #42; another Tracker's (PROJ-123) as it is
export const idText = (id: string) => (/^\d+$/.test(id) ? `#${id}` : id);

export type RunState = 'off' | 'stopped' | 'idle' | 'watching' | 'paused';

// A dead pid is stopped, whatever status.json says.
export function runState(view: FactoryView): RunState {
	if (view.status === null) return 'off';
	if (view.stopped) return 'stopped';
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

// With no run going there is no Queue to show, only history.
export const running = (view: FactoryView) => {
	const state = runState(view);
	return state !== 'off' && state !== 'stopped';
};

// The Feature the next --watch poll waits for, or null when no Feature is being built under --watch.
export function pollAfter(view: FactoryView): string | null {
	const doing = view.status?.doing;
	return view.status?.watching === true && doing?.kind === 'building' && running(view)
		? idText(doing.feature)
		: null;
}
