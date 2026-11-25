// The Measures panel's data for `nightjar ui`: the ledger, the status file and the pull states cached under .factory/, and the watch that keeps those pull states read, an hour apart at the most.
import type { CodeHost } from './code-host.js';
import { ledgerPath, readEntries } from './ledger.js';
import { measures, openedPulls, withinWindow, type Measures, type PullStates } from './measures.js';
import { measuresPath, readPullStates, refreshPullStates } from './measures-cache.js';
import { why } from './say.js';
import type { Status } from './status-shape.js';
import { TRACKER_EVERY_MS } from './ui-tracker.js';

// The Code host as the Measures hold it: only whether a pull request merged, and its commits.
export type PullStateReader = Pick<CodeHost, 'pullState'>;

// What the watch knows of the Code host.
export interface CodeHostKnown {
	// `unread` until the Code host has been opened; `none` when it has no pullState
	readonly reader: 'unread' | 'has' | 'none';
	// why the Code host could not be opened or asked, null when it could
	readonly fault: string | null;
}

const UNREAD: CodeHostKnown = { reader: 'unread', fault: null };

// What the page knows when it was given no Code host to ask.
export const NO_PULL_STATE: CodeHostKnown = { reader: 'none', fault: null };

// What the panel draws: the measures, and what is to be said of Autonomy beside them.
export interface MeasuresView {
	readonly measures: Measures;
	// plain text under the measures, or null when there is nothing to say
	readonly note: string | null;
}

// The Measures at `now`, read from .factory/ alone: the Code host is asked by the watch, never here.
export function measuresView(
	root: string,
	status: Status | null,
	known: CodeHostKnown,
	now: Date
): MeasuresView {
	const cache = readPullStates(measuresPath(root));
	const pullStates: PullStates =
		known.reader === 'none' ? null : new Map(Object.entries(cache?.states ?? {}));
	const result = measures({ entries: readEntries(ledgerPath(root)), status, pullStates, now });
	const fault = known.fault ?? cache?.fault;
	let note: string | null = null;
	if (result.autonomy.kind === 'unavailable') {
		note =
			'Autonomy is not shown: this Code host cannot say which pull requests merged (it has no pullState).';
	} else if (fault !== undefined) {
		note = `Autonomy may be out of date: could not read the Code host: ${fault}`;
	}
	return { measures: result, note };
}

export interface MeasuresWatchOptions {
	readonly root: string;
	// the Code host, opened on the first call; its `pullState` is absent on a Code host without it
	readonly codeHost: () => Promise<PullStateReader>;
	// the status file as the page last read it
	readonly status: () => Status | null;
	// told after each look, whether it read the Code host or not
	readonly changed: () => void;
	readonly every?: (ms: number, tick: () => void) => () => void;
	readonly now?: () => Date;
}

export interface MeasuresWatch {
	readonly known: () => CodeHostKnown;
	// the look in flight, done at once when there is none
	readonly looking: () => Promise<void>;
	readonly stop: () => void;
}

const everyMs = (ms: number, tick: () => void) => {
	const timer = setInterval(tick, ms);
	return () => clearInterval(timer);
};

// Looks at once and every minute whether the pull states are due. The look costs a file read; the Code host is asked only when the cache is an hour old, so a page left open reads it once an hour.
export function watchMeasures(o: MeasuresWatchOptions): MeasuresWatch {
	const now = o.now ?? (() => new Date());
	let known: CodeHostKnown = UNREAD;
	let inFlight: Promise<void> | null = null;
	let stopped = false;
	const look = async () => {
		let codeHost: PullStateReader;
		try {
			codeHost = await o.codeHost();
		} catch (fault) {
			known = { reader: 'unread', fault: why(fault) };
			return;
		}
		const pullState = codeHost.pullState?.bind(codeHost);
		if (pullState === undefined) {
			known = { reader: 'none', fault: null };
			return;
		}
		known = { reader: 'has', fault: null };
		const at = now();
		const urls = withinWindow(openedPulls(readEntries(ledgerPath(o.root)), o.status()), at).map(
			(p) => p.url
		);
		try {
			await refreshPullStates({
				path: measuresPath(o.root),
				codeHost: { pullState },
				urls,
				now: at
			});
		} catch (fault) {
			known = { reader: 'has', fault: why(fault) };
		}
	};
	const tick = () => {
		if (inFlight !== null || stopped) return;
		inFlight = look().then(() => {
			inFlight = null;
			if (!stopped) o.changed();
		});
	};
	tick();
	const stopTicks = (o.every ?? everyMs)(TRACKER_EVERY_MS, tick);
	return {
		known: () => known,
		looking: () => inFlight ?? Promise.resolve(),
		stop: () => {
			stopped = true;
			stopTicks();
		}
	};
}
