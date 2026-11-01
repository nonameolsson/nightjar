// The shape of .factory/status.json, defined once for the writer and the plugin; types only, so the plugin can import it.

export type Doing =
	| { readonly kind: 'idle'; readonly nextPollAt: string }
	| {
			readonly kind: 'building';
			readonly feature: string;
			// null while the Feature is set up and reviewed, and during a Step that runs after all Tickets
			readonly ticket: string | null;
			readonly step: 'setup' | 'build' | 'fix' | 'review' | 'step';
			// a build's question round or a fix round, of how many there may be
			readonly round: number | null;
			readonly rounds: number | null;
			readonly session: string | null;
			readonly startedAt: string;
	  }
	| { readonly kind: 'paused'; readonly why: string; readonly until: string | null }
	| { readonly kind: 'off' };

export type Happened =
	| { readonly kind: 'built'; readonly feature: string; readonly ticket: string }
	| {
			readonly kind: 'needs-info';
			readonly feature: string;
			readonly ticket: string | null;
			readonly why: string;
	  }
	| { readonly kind: 'failed'; readonly feature: string; readonly why: string }
	| { readonly kind: 'pull'; readonly feature: string; readonly url: string }
	| { readonly kind: 'stale'; readonly commit: string };

export type Event = Happened & { readonly seq: number; readonly at: string };

export interface Status {
	readonly at: string;
	readonly pid: number;
	readonly spentTodayUsd: number;
	readonly dailyUsd: number;
	readonly doing: Doing;
	// the last ten, oldest first; a reader toasts each seq it has not seen
	readonly recent: Event[];
	// the commit of newer Nightjar code than the one running; nothing sets it yet, older files lack it
	readonly codeMoved?: string | null;
}
