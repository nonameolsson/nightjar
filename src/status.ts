// .factory/status.json, rewritten at every change, for a status line or toasts to read.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { needsAPerson } from './plan.js';
import type { Spend } from './spend.js';
import type {
	Doing,
	Event,
	HandBack,
	Happened,
	Named,
	Queued,
	Status,
	WaitingItem,
	WaitingOnYou
} from './status-shape.js';

export type {
	Doing,
	Event,
	HandBack,
	Happened,
	Named,
	Queued,
	Status,
	TicketCounts,
	TicketProgress,
	WaitingItem,
	WaitingOnYou
} from './status-shape.js';

// The Tickets among `tickets` that need info or a person, as Waiting on you lists them.
export const waitingTickets = (
	tickets: readonly (Named & { readonly why?: string })[],
	feature: string
) =>
	tickets.filter(needsAPerson).map((t): WaitingItem => ({
		kind: 'ticket',
		id: t.id,
		title: t.title,
		why: t.why ?? '',
		feature
	}));

// When the Feature being built began; a file older than featureStartedAt has only the step's start.
export const featureStart = (doing: Extract<Doing, { kind: 'building' }>) =>
	doing.featureStartedAt ?? doing.startedAt;

export const statusPath = (root: string) => join(root, '.factory', 'status.json');

// What the build loop tells the status file; a spec records it instead.
export interface StatusReport {
	readonly doing: (doing: Doing) => void;
	readonly happened: (event: Happened) => void;
	// newer Nightjar code than the one running: its version or commit
	readonly codeMoved: (newer: string) => void;
	// the Queue and Waiting on you, which the loop refreshes between Features and on each idle poll
	readonly refreshed: (queue: Queued[], waitingOnYou: WaitingOnYou) => void;
}

const KEEP = 10;
// hand-backs outlive `recent`, one per Feature and Ticket, so a view can say why long after
const KEEP_HANDED_BACK = 50;

type Item = Pick<HandBack, 'feature' | 'ticket'>;
const sameItem = (a: Item, b: Item) => a.feature === b.feature && a.ticket === b.ticket;

const StatusSchema = z.looseObject({
	recent: z.array(z.looseObject({ seq: z.int() }))
});

export function readStatus(path: string): Status | null {
	try {
		const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
		return StatusSchema.safeParse(value).success ? (value as Status) : null;
	} catch {
		return null;
	}
}

export class StatusFile implements StatusReport {
	private now: Doing = { kind: 'off' };
	private moved: string | null = null;
	private recent: Event[];
	private handedBack: HandBack[];
	private refresh: { queue: Queued[]; waitingOnYou: WaitingOnYou; at: string } | null = null;

	constructor(
		private readonly o: {
			readonly path: string;
			readonly spend: Spend;
			readonly now: () => Date;
			readonly pid: number;
			readonly dailyUsd: number;
			// under --watch
			readonly watching?: boolean;
		}
	) {
		const last = readStatus(o.path);
		// the events go on from the last run's, so a reader that saw them does not toast them again
		this.recent = last?.recent ?? [];
		this.handedBack = last?.handedBack ?? [];
	}

	readonly doing = (doing: Doing) => {
		// a Feature that starts building again is no longer handed back; its waiting Tickets still are
		const was = this.now;
		if (doing.kind === 'building' && !(was.kind === 'building' && was.feature === doing.feature)) {
			const own: Item = { feature: doing.feature, ticket: null };
			this.handedBack = this.handedBack.filter((h) => !sameItem(h, own));
		}
		this.now = doing;
		// with no run going there is no Queue
		if (doing.kind === 'off') this.refresh = null;
		this.write();
	};

	readonly happened = (event: Happened) => {
		const seq = (this.recent.at(-1)?.seq ?? 0) + 1;
		const at = this.o.now().toISOString();
		this.recent = [...this.recent, { ...event, seq, at }].slice(-KEEP);
		if (event.kind === 'needs-info' || event.kind === 'failed') {
			const handBack: HandBack = {
				feature: event.feature,
				ticket: event.kind === 'needs-info' ? event.ticket : null,
				why: event.why,
				...(event.next === undefined ? {} : { next: event.next }),
				at
			};
			const others = this.handedBack.filter((h) => !sameItem(h, handBack));
			this.handedBack = [...others, handBack].slice(-KEEP_HANDED_BACK);
		}
		this.write();
	};

	readonly codeMoved = (newer: string) => {
		this.moved = newer;
		this.write();
	};

	readonly refreshed = (queue: Queued[], waitingOnYou: WaitingOnYou) => {
		this.refresh = { queue, waitingOnYou, at: this.o.now().toISOString() };
		this.write();
	};

	// While a Feature builds, its own Tickets that need info or a person stand in place of the last Feature's
	private waitingOnYou(found: WaitingOnYou): WaitingOnYou {
		if (this.now.kind !== 'building') return found;
		const tickets = waitingTickets(this.now.tickets ?? [], this.now.feature);
		return { ...found, items: [...found.items.filter((i) => i.kind === 'feature'), ...tickets] };
	}

	private write() {
		const now = this.o.now();
		const status: Status = {
			at: now.toISOString(),
			pid: this.o.pid,
			spentTodayUsd: this.o.spend.today(now),
			dailyUsd: this.o.dailyUsd,
			doing: this.now,
			...(this.o.watching === true ? { watching: true } : {}),
			recent: this.recent,
			...(this.handedBack.length === 0 ? {} : { handedBack: this.handedBack }),
			codeMoved: this.moved,
			...(this.refresh === null
				? {}
				: {
						queue: this.refresh.queue,
						waitingOnYou: this.waitingOnYou(this.refresh.waitingOnYou),
						refreshedAt: this.refresh.at
					})
		};
		mkdirSync(dirname(this.o.path), { recursive: true });
		const temp = `${this.o.path}.${String(this.o.pid)}.tmp`;
		writeFileSync(temp, `${JSON.stringify(status, null, '\t')}\n`);
		renameSync(temp, this.o.path);
	}
}
