// The last seven local days, which the Overview opens with: Features completed, failed and handed to a person, and the dollars spent.

// The counts the Overview shows; each Feature counts once under each heading.
export interface Week {
	// Features whose latest outcome in the week was a draft pull request
	readonly completed: number;
	// Features whose latest outcome in the week was a failure
	readonly failed: number;
	// Features handed to a person in the week, whether the Feature itself or one of its Tickets, apart from those that failed, which Nightjar hands back too
	readonly handed: number;
	// the estimated dollars of the week's Sessions
	readonly spentUsd: number;
}

export const NO_WEEK: Week = { completed: 0, failed: 0, handed: 0, spentUsd: 0 };

// What the week is counted from. Each `at` is a moment; the Feature outcomes and hand-backs are the Logbooks' and those status.json still holds, so one may come twice.
export interface WeekSource {
	// the Sessions in the ledger
	readonly sessions: readonly { readonly at: number; readonly costUsd: number }[];
	// each Feature's finished runs, in any order
	readonly outcomes: readonly {
		readonly feature: string;
		readonly kind: 'pull' | 'failed';
		readonly at: string;
	}[];
	// the Features and Tickets handed to a person
	readonly handedBack: readonly { readonly feature: string; readonly at: string }[];
}

// The week as `[from, until)`: the local day of `now` and the six before it, from midnight to midnight, as `today()` counts a day.
export function weekOf(now: Date): { readonly from: number; readonly until: number } {
	const midnight = (daysBack: number) =>
		new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).getTime();
	return { from: midnight(6), until: midnight(-1) };
}

export function lastWeek(source: WeekSource, now: Date): Week {
	const { from, until } = weekOf(now);
	// a moment that does not read is in no week
	const inWeek = (at: number) => at >= from && at < until;
	let spentUsd = 0;
	for (const s of source.sessions) if (inWeek(s.at)) spentUsd += s.costUsd;
	// a Feature counts by how it last ended in the week, so a failure that a later run mended is a completion only
	// at the same moment the one listed later wins
	const latest = new Map<string, { readonly at: number; readonly kind: 'pull' | 'failed' }>();
	for (const o of source.outcomes) {
		const at = Date.parse(o.at);
		if (!inWeek(at)) continue;
		if (at >= (latest.get(o.feature)?.at ?? -Infinity)) latest.set(o.feature, { at, kind: o.kind });
	}
	const kinds = [...latest.values()].map((o) => o.kind);
	// a failed Feature is handed back too; it counts as failed alone
	const handed = new Set<string>();
	for (const h of source.handedBack)
		if (inWeek(Date.parse(h.at)) && latest.get(h.feature)?.kind !== 'failed') handed.add(h.feature);
	return {
		completed: kinds.filter((k) => k === 'pull').length,
		failed: kinds.filter((k) => k === 'failed').length,
		handed: handed.size,
		spentUsd
	};
}
