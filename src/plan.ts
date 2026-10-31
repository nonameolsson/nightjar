// The Build order (GLOSSARY.md): which of a Feature's Tickets to build next, the first in the
// Feature's own order whose blockers are all closed or already built on the Feature's branch.
import type { Ticket } from './tracker.js';

const unblocked = (ticket: Ticket, built: ReadonlySet<number>) =>
	ticket.blockedBy.every((b) => !b.open || built.has(b.id));

const buildable = (ticket: Ticket, built: ReadonlySet<number>) =>
	ticket.open &&
	!built.has(ticket.id) &&
	ticket.signals.includes('ready') &&
	unblocked(ticket, built);

export function nextTicket(tickets: readonly Ticket[], built: ReadonlySet<number>): Ticket | null {
	return tickets.find((t) => buildable(t, built)) ?? null;
}

export interface Waiting {
	readonly id: number;
	readonly title: string;
	readonly why: string;
	// the Ticket it waits for, which `why` leaves each place to name its own way
	readonly blocker?: number;
}

// The open Tickets a run leaves unbuilt, for the pull request and the Feature's comment.
export function waiting(tickets: readonly Ticket[], built: ReadonlySet<number>): Waiting[] {
	return tickets
		.filter((t) => t.open && !built.has(t.id))
		.map((t) => ({ id: t.id, title: t.title, ...whyWaiting(t, built) }));
}

function whyWaiting(ticket: Ticket, built: ReadonlySet<number>): Pick<Waiting, 'why' | 'blocker'> {
	if (ticket.signals.includes('human')) return { why: 'needs a person' };
	if (ticket.signals.includes('needsInfo')) return { why: 'needs info' };
	const blocker = ticket.blockedBy.find((b) => b.open && !built.has(b.id));
	if (blocker) return { why: 'blocked by', blocker: blocker.id };
	if (!ticket.signals.includes('ready')) return { why: 'not marked ready' };
	return { why: 'not reached' };
}
