// `nightjar create FILE`: makes a Feature and its Tickets from a Feature file on the Tracker
// factory.json names. The Tickets get the ready Signal; the Feature gets none, so nothing is built
// until a person gives it the Go.
import type { FeaturePlan } from './feature-file.js';
import type { FeatureWriter, Tracker } from './tracker.js';

export interface Made {
	readonly feature: number;
	// in the file's order
	readonly tickets: readonly number[];
}

const said = (fault: unknown) => (fault instanceof Error ? fault.message : String(fault));

const listed = (texts: readonly string[]) =>
	texts.length < 2 ? texts.join('') : `${texts.slice(0, -1).join(', ')} and ${texts.at(-1) ?? ''}`;

// Each Ticket is linked to its blockers before it is marked ready, so it is never ready half made.
export async function makeFeature(
	tracker: Tracker & FeatureWriter,
	plan: FeaturePlan,
	say: (line: string) => void
): Promise<Made> {
	const ref = (id: number) => tracker.reference(id).text;
	const made: number[] = [];
	try {
		const feature = await tracker.createFeature(plan.feature);
		made.push(feature);
		say(`made the Feature ${ref(feature)} ${plan.feature.title}`);
		const ids = new Map<number, number>();
		for (const ticket of plan.tickets) {
			const id = await tracker.createTicket(feature, ticket);
			made.push(id);
			ids.set(ticket.number, id);
			const blockers = ticket.blockedBy.map((n) => ids.get(n) ?? NaN);
			for (const blocker of blockers) await tracker.block(id, blocker);
			await tracker.addSignal(id, 'ready');
			const blocked = blockers.length === 0 ? '' : `, blocked by ${listed(blockers.map(ref))}`;
			say(`made Ticket ${String(ticket.number)} as ${ref(id)} ${ticket.title}${blocked}, ready`);
		}
		return { feature, tickets: made.slice(1) };
	} catch (fault) {
		const before = made.length === 0 ? 'nothing' : made.map(ref).join(', ');
		throw new Error(`${said(fault)}; made before it: ${before}. Nothing was undone.`, {
			cause: fault
		});
	}
}
