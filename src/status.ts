// .factory/status.json: what Nightjar does right now and what it did last, rewritten at every
// change, for a status line or toasts to read.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { spentOn } from './ledger.js';

export const statusPath = (root: string) => join(root, '.factory', 'status.json');

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
	// kept for the file's shape; nothing sets it yet
	readonly codeMoved: string | null;
}

// What the build loop tells the status file; a spec records it instead.
export interface StatusReport {
	readonly doing: (doing: Doing) => void;
	readonly happened: (event: Happened) => void;
}

const KEEP = 10;

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

export class StatusBoard implements StatusReport {
	private now: Doing = { kind: 'off' };
	private recent: Event[];

	constructor(
		private readonly o: {
			readonly path: string;
			readonly ledger: string;
			readonly now: () => Date;
			readonly pid: number;
			readonly dailyUsd: number;
		}
	) {
		// the events go on from the last run's, so a reader that saw them does not toast them again
		this.recent = readStatus(o.path)?.recent ?? [];
	}

	readonly doing = (doing: Doing) => {
		this.now = doing;
		this.write();
	};

	readonly happened = (event: Happened) => {
		const seq = (this.recent.at(-1)?.seq ?? 0) + 1;
		const at = this.o.now().toISOString();
		this.recent = [...this.recent, { ...event, seq, at }].slice(-KEEP);
		this.write();
	};

	private write() {
		const now = this.o.now();
		const status: Status = {
			at: now.toISOString(),
			pid: this.o.pid,
			spentTodayUsd: spentOn(this.o.ledger, now),
			dailyUsd: this.o.dailyUsd,
			doing: this.now,
			recent: this.recent,
			codeMoved: null
		};
		mkdirSync(dirname(this.o.path), { recursive: true });
		const temp = `${this.o.path}.${String(this.o.pid)}.tmp`;
		writeFileSync(temp, `${JSON.stringify(status, null, '\t')}\n`);
		renameSync(temp, this.o.path);
	}
}
