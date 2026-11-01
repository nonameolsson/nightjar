// The Tracker seam (docs/adr/0001): the build loop calls nothing else there.
import type { Signal } from './signals.js';

// An item's id as its Tracker spells it (`42`, `PROJ-123`); Nightjar never reads meaning into it.
export type ItemId = string;

export interface Feature {
	readonly id: ItemId;
	readonly title: string;
	readonly body: string;
}

export interface Ticket {
	readonly id: ItemId;
	readonly title: string;
	readonly body: string;
	readonly open: boolean;
	readonly signals: readonly Signal[];
	// the Tickets that must be closed or built first
	readonly blockedBy: readonly Blocker[];
}

export interface Blocker {
	readonly id: ItemId;
	readonly open: boolean;
}

export interface Comment {
	readonly author: string;
	readonly body: string;
	readonly at: string;
	// whether its author is trusted, so the comment may reach the Coding agent
	readonly trusted: boolean;
}

// How a Ticket is linked to a pull request: `text` goes where the Code host shows references.
export interface TicketReference {
	readonly id: ItemId;
	readonly text: string;
}

// Who a Feature is assigned to and which Signals it carries.
export interface Standing {
	readonly assignees: readonly string[];
	readonly signals: readonly Signal[];
}

export interface Tracker {
	// the signed-in person
	me(): Promise<string>;
	// the open Features assigned to `person` that carry the Go, oldest first
	assignedFeatures(person: string): Promise<Feature[]>;
	feature(id: ItemId): Promise<Feature>;
	// read before `nightjar <id>` claims a Feature; the signed-in person goes by the name `me` gives
	standing(id: ItemId): Promise<Standing>;
	// the Feature's Tickets in its own child order, each with its blockers
	tickets(featureId: ItemId): Promise<Ticket[]>;
	// the comments on a Feature or Ticket, oldest first
	comments(id: ItemId): Promise<Comment[]>;
	addSignal(id: ItemId, signal: Signal): Promise<void>;
	// a Signal the item does not carry is no fault
	removeSignal(id: ItemId, signal: Signal): Promise<void>;
	comment(id: ItemId, body: string): Promise<void>;
	reference(id: ItemId): TicketReference;
}

// The title and body of a Feature or Ticket to be made.
export interface ItemText {
	readonly title: string;
	readonly body: string;
}

// The optional half that makes Features, for `nightjar create`; apart, so a Tracker module written before it still loads.
export interface FeatureWriter {
	// a Feature that carries no Signal and is assigned to no one; gives its id
	createFeature(feature: ItemText): Promise<ItemId>;
	// a Ticket made the Feature's last child, carrying no Signal; gives its id
	createTicket(featureId: ItemId, ticket: ItemText): Promise<ItemId>;
	// links `id` as blocked by `blocker`, so `tickets` gives `blocker` among its blockers
	block(id: ItemId, blocker: ItemId): Promise<void>;
}

// Typed as a record, so a method added to FeatureWriter fails to compile until it is listed here.
const WRITER_METHODS: Record<keyof FeatureWriter, true> = {
	createFeature: true,
	createTicket: true,
	block: true
};

export const FEATURE_WRITER_METHODS = Object.keys(
	WRITER_METHODS
) as readonly (keyof FeatureWriter)[];

export function canCreate(tracker: Tracker): tracker is Tracker & FeatureWriter {
	const methods = tracker as unknown as Record<string, unknown>;
	return FEATURE_WRITER_METHODS.every((name) => typeof methods[name] === 'function');
}
