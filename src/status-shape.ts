// The shape of .factory/status.json, defined once: src/status.ts writes it and the Claude Code
// plugin in plugin/nightjar-status reads it. Types only, so the plugin can import it.

export type Doing =
	| { readonly kind: 'idle'; readonly nextPollAt: string }
	| {
			readonly kind: 'building';
			readonly feature: number;
			// null while the Feature is set up and while it is reviewed
			readonly ticket: number | null;
			readonly step: 'setup' | 'build' | 'fix' | 'review';
			// a build's question round or a fix round, of how many there may be
			readonly round: number | null;
			readonly rounds: number | null;
			readonly session: string | null;
			readonly startedAt: string;
	  }
	| { readonly kind: 'paused'; readonly why: string; readonly until: string | null }
	| { readonly kind: 'off' };

export type Happened =
	| { readonly kind: 'built'; readonly feature: number; readonly ticket: number }
	| {
			readonly kind: 'needs-info';
			readonly feature: number;
			readonly ticket: number | null;
			readonly why: string;
	  }
	| { readonly kind: 'failed'; readonly feature: number; readonly why: string }
	| { readonly kind: 'pull'; readonly feature: number; readonly url: string }
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
