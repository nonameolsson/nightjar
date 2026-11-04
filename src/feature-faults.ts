// What is wrong across a Feature's Tickets rather than in one Ticket's body (docs/ticket-contract.md): checked by `nightjar doctor FEATURE` only, never before a Session.
import type { Feature, ItemId, Ticket } from './tracker.js';
import { workflowLine } from './workflow.js';

export interface FeatureFaults {
	// the faults of each open Ticket, by its id; a Ticket that holds is absent
	readonly tickets: ReadonlyMap<ItemId, readonly string[]>;
	// the faults of the Feature as a whole
	readonly feature: readonly string[];
}

// The groups of open Tickets that wait on each other, each as its members in the Feature's order.
function loops(open: readonly Ticket[]): Ticket[][] {
	const byId = new Map(open.map((t) => [t.id, t]));
	const next = (t: Ticket): Ticket[] =>
		t.blockedBy.flatMap((b) => {
			const blocker = byId.get(b.id);
			return blocker === undefined ? [] : [blocker];
		});
	// Tarjan's strongly connected components
	const index = new Map<ItemId, number>();
	const low = new Map<ItemId, number>();
	const stack: Ticket[] = [];
	const onStack = new Set<ItemId>();
	const found: Ticket[][] = [];
	let counter = 0;
	const visit = (t: Ticket): void => {
		index.set(t.id, counter);
		low.set(t.id, counter);
		counter += 1;
		stack.push(t);
		onStack.add(t.id);
		for (const n of next(t)) {
			if (!index.has(n.id)) {
				visit(n);
				low.set(t.id, Math.min(low.get(t.id) ?? 0, low.get(n.id) ?? 0));
			} else if (onStack.has(n.id)) {
				low.set(t.id, Math.min(low.get(t.id) ?? 0, index.get(n.id) ?? 0));
			}
		}
		if (low.get(t.id) !== index.get(t.id)) return;
		const group: Ticket[] = [];
		for (;;) {
			const member = stack.pop();
			if (member === undefined) break;
			onStack.delete(member.id);
			group.push(member);
			if (member.id === t.id) break;
		}
		if (group.length > 1 || next(t).some((n) => n.id === t.id)) found.push(group);
	};
	for (const t of open) if (!index.has(t.id)) visit(t);
	const order = (t: Ticket) => open.indexOf(t);
	return found.map((g) => g.sort((a, b) => order(a) - order(b)));
}

// The faults across `tickets`, the whole of a Feature's Tickets: an open blocker outside them, a blocking loop,
// an open Ticket a build would skip, no open Ticket, and a Workflow `workflows` does not name.
// `ref` spells an item's id as the Tracker does.
export function featureFaults(
	feature: Feature,
	tickets: readonly Ticket[],
	workflows: readonly string[],
	ref: (id: ItemId) => string
): FeatureFaults {
	const open = tickets.filter((t) => t.open);
	const own = new Set(tickets.map((t) => t.id));
	const forTickets = new Map<ItemId, string[]>();
	const add = (id: ItemId, fault: string) =>
		forTickets.set(id, [...(forTickets.get(id) ?? []), fault]);
	for (const ticket of open) {
		for (const blocker of ticket.blockedBy) {
			if (blocker.open && !own.has(blocker.id)) {
				add(
					ticket.id,
					`It is blocked by ${ref(blocker.id)}, which is open and not a Ticket of this Feature, so a build never reaches it; close the blocker or take the link off.`
				);
			}
		}
		if (!ticket.signals.includes('ready')) {
			add(
				ticket.id,
				'It does not carry the ready Signal, so a build skips it; give it the Signal or close it.'
			);
		}
	}
	const forFeature: string[] = [];
	if (open.length === 0) {
		forFeature.push('It has no open Ticket, so a build has nothing to do.');
	}
	for (const group of loops(open)) {
		const names = group.map((t) => ref(t.id)).join(', ');
		forFeature.push(`The Tickets ${names} block each other in a loop, so none of them is built.`);
	}
	const asked = workflowLine(feature.body);
	if (asked !== undefined && !workflows.some((n) => n.toLowerCase() === asked.toLowerCase())) {
		const known = workflows.length === 0 ? 'factory.json names none' : workflows.join(', ');
		forFeature.push(
			`Its **Workflow:** line names \`${asked}\`, which factory.json does not have. The Workflows known: ${known}.`
		);
	}
	return { tickets: forTickets, feature: forFeature };
}
