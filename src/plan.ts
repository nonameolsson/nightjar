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
}

// The open Tickets a run leaves unbuilt, for the pull request and the Feature's comment.
export function waiting(tickets: readonly Ticket[], built: ReadonlySet<number>): Waiting[] {
	return tickets
		.filter((t) => t.open && !built.has(t.id))
		.map((t) => ({ id: t.id, title: t.title, why: whyWaiting(t, built) }));
}

function whyWaiting(ticket: Ticket, built: ReadonlySet<number>): string {
	if (ticket.signals.includes('human')) return 'needs a person';
	if (ticket.signals.includes('needsInfo')) return 'needs info';
	const blocker = ticket.blockedBy.find((b) => b.open && !built.has(b.id));
	if (blocker) return `blocked by #${String(blocker.id)}`;
	if (!ticket.signals.includes('ready')) return 'not marked ready';
	return 'not reached';
}
