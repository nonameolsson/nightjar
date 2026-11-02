// The Build order (GLOSSARY.md): the first Ticket in the Feature's order whose blockers are closed or built on the branch.
import type { TicketProgress } from './status-shape.js';
import type { ItemId, Ticket } from './tracker.js';

const unblocked = (ticket: Ticket, built: ReadonlySet<ItemId>) =>
	ticket.blockedBy.every((b) => !b.open || built.has(b.id));

const buildable = (ticket: Ticket, built: ReadonlySet<ItemId>) =>
	ticket.open &&
	!built.has(ticket.id) &&
	ticket.signals.includes('ready') &&
	unblocked(ticket, built);

export function nextTicket(tickets: readonly Ticket[], built: ReadonlySet<ItemId>): Ticket | null {
	return tickets.find((t) => buildable(t, built)) ?? null;
}

export interface Waiting {
	readonly id: ItemId;
	readonly title: string;
	readonly why: string;
	// the Ticket it waits for, which `why` leaves each place to name its own way
	readonly blocker?: ItemId;
}

// The open Tickets a run leaves unbuilt, for the pull request and the Feature's comment.
export function waiting(tickets: readonly Ticket[], built: ReadonlySet<ItemId>): Waiting[] {
	return tickets
		.filter((t) => t.open && !built.has(t.id))
		.map((t) => ({ id: t.id, title: t.title, ...whyWaiting(t, built) }));
}

function whyWaiting(ticket: Ticket, built: ReadonlySet<ItemId>): Pick<Waiting, 'why' | 'blocker'> {
	if (ticket.signals.includes('human')) return { why: 'needs a person' };
	if (ticket.signals.includes('needsInfo')) return { why: 'needs info' };
	const blocker = ticket.blockedBy.find((b) => b.open && !built.has(b.id));
	if (blocker) return { why: 'blocked by', blocker: blocker.id };
	if (!ticket.signals.includes('ready')) return { why: 'not marked ready' };
	return { why: 'not reached' };
}

// Whether a Ticket is left for a person, who is what Waiting on you lists.
export const needsAPerson = (w: Waiting) => w.why === 'needs a person' || w.why === 'needs info';

// The Feature's Tickets for a view: the open ones plus those built on the branch, each built, building or waiting with its reason.
export function progress(
	tickets: readonly Ticket[],
	built: ReadonlySet<ItemId>,
	current: ItemId | null
): TicketProgress[] {
	const left = new Map(waiting(tickets, built).map((w) => [w.id, w]));
	return tickets
		.filter((t) => t.open || built.has(t.id))
		.map((t): TicketProgress => {
			const { id, title } = t;
			if (built.has(id)) return { id, title, state: 'built' };
			if (id === current) return { id, title, state: 'building' };
			const w = left.get(id);
			return {
				id,
				title,
				state: 'waiting',
				...(w === undefined
					? {}
					: { why: w.blocker === undefined ? w.why : `${w.why} #${w.blocker}` })
			};
		});
}
