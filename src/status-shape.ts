// The shape of .factory/status.json, defined once for the writer and the plugin; types only, so the plugin can import it.

// One Ticket of the Feature being built, as a view shows it.
export interface TicketProgress {
	readonly id: string;
	readonly title: string;
	readonly state: 'built' | 'building' | 'waiting';
	// what a waiting Ticket waits for, in plan.ts's words
	readonly why?: string;
}

// A Feature in the Queue: id and title only, as a Ticket count would cost a Tracker call each.
export interface Queued {
	readonly id: string;
	readonly title: string;
}

// A Feature or Ticket that carries needs info or needs a person.
export interface WaitingItem {
	readonly kind: 'feature' | 'ticket';
	readonly id: string;
	readonly title: string;
	readonly why: string;
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
			readonly startedAt: string;
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
	  }
	| {
			readonly kind: 'pull';
			readonly feature: string;
			readonly title?: string;
			readonly url: string;
	  }
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
	// the Features waiting to be built, oldest first, the current one not among them; older files lack it
	readonly queue?: Queued[];
	readonly waitingOnYou?: WaitingOnYou;
	// when queue and waitingOnYou were last refreshed: between Features and on each idle poll, never mid-build
	readonly refreshedAt?: string;
}
