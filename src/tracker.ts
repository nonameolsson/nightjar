// The Tracker seam (docs/adr/0001): everything the build loop reads from or writes to the system
// that holds Features, Tickets, Signals and comments. The build loop calls nothing else there.
import type { Signal } from './signals.js';

export interface Feature {
	readonly id: number;
	readonly title: string;
	readonly body: string;
}

export interface Ticket {
	readonly id: number;
	readonly title: string;
	readonly body: string;
	readonly open: boolean;
	readonly signals: readonly Signal[];
	// the Tickets that must be closed or built first
	readonly blockedBy: readonly Blocker[];
}

export interface Blocker {
	readonly id: number;
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
	readonly id: number;
	readonly text: string;
}

export interface Tracker {
	// the signed-in person
	me(): Promise<string>;
	// the open Features assigned to `person` that carry the Go, oldest first
	assignedFeatures(person: string): Promise<Feature[]>;
	feature(id: number): Promise<Feature>;
	// the Feature's Tickets in its own child order, each with its blockers
	tickets(featureId: number): Promise<Ticket[]>;
	// the comments on a Feature or Ticket, oldest first
	comments(id: number): Promise<Comment[]>;
	addSignal(id: number, signal: Signal): Promise<void>;
	// a Signal the item does not carry is no fault
	removeSignal(id: number, signal: Signal): Promise<void>;
	comment(id: number, body: string): Promise<void>;
	reference(id: number): TicketReference;
}
