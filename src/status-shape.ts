// The shape of .factory/status.json, defined once for the writer and the plugin; types only, so the plugin can import it.

// A Feature or Ticket as a view names it.
export interface Named {
	readonly id: string;
	readonly title: string;
}

// One Ticket of the Feature being built, as a view shows it.
export interface TicketProgress extends Named {
	readonly state: 'built' | 'building' | 'waiting';
	// what a waiting Ticket waits for, in plan.ts's words
	readonly why?: string;
}

// How many Tickets a Feature has and how many are closed.
export interface TicketCounts {
	readonly total: number;
	readonly closed: number;
}

// A Feature in the Queue. `ticketCounts` is null when the Tracker could not read them, and absent when it cannot count or the file is older.
export interface Queued extends Named {
	readonly ticketCounts?: TicketCounts | null;
}

// A Feature or Ticket that carries needs info or needs a person; counts only on a Feature.
export interface WaitingItem extends Named {
	readonly kind: 'feature' | 'ticket';
	readonly why: string;
	readonly ticketCounts?: TicketCounts | null;
}

export interface WaitingOnYou {
	readonly items: WaitingItem[];
	// true while the Tracker cannot list Features, so items holds only the current Feature's Tickets
	readonly trackerCannotList: boolean;
}

export type Doing =
	| { readonly kind: 'idle'; readonly nextPollAt: string }
	| {
			readonly kind: 'building';
			readonly feature: string;
			// the Feature's title; older files lack it
			readonly title?: string;
			// null while the Feature is set up and reviewed, and during a Step that runs after all Tickets
			readonly ticket: string | null;
			readonly step: 'setup' | 'build' | 'fix' | 'review' | 'step';
			// a build's question round or a fix round, of how many there may be
			readonly round: number | null;
			readonly rounds: number | null;
			readonly session: string | null;
			// when the step began
			readonly startedAt: string;
			// when the Feature's build began, which every step keeps; older files lack it
			readonly featureStartedAt?: string;
			// the Feature's open Tickets at planning plus those built on the branch; older files lack it
			readonly tickets?: TicketProgress[];
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
	| {
			readonly kind: 'failed';
			readonly feature: string;
			// the Feature's title, for a view's list of outcomes; older files and a run by id lack it
			readonly title?: string;
			readonly why: string;
			// when the Feature's build began; older files and a fault outside a build lack it
			readonly startedAt?: string;
	  }
	| {
			readonly kind: 'pull';
			readonly feature: string;
			readonly title?: string;
			readonly url: string;
			// when the Feature's build began; older files lack it
			readonly startedAt?: string;
	  }
	// newer Nightjar code: `commit` is the newer version, or the commit of a linked checkout
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
	// true under --watch, whose next poll comes when the Feature being built ends; older files lack it
	readonly watching?: boolean;
	// the version or commit of newer Nightjar code than the one running; older files lack it
	readonly codeMoved?: string | null;
	// the Features waiting to be built, oldest first, the current one not among them; older files lack it
	readonly queue?: Queued[];
	readonly waitingOnYou?: WaitingOnYou;
	// when queue and waitingOnYou were last refreshed: between Features and on each idle poll, never mid-build
	readonly refreshedAt?: string;
}
