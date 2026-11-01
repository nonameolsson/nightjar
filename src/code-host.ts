// The Code host seam (docs/adr/0001): the build loop calls nothing else there.
import type { TicketReference } from './tracker.js';

export interface Pull {
	readonly id: number;
	readonly url: string;
}

export interface DraftRequest {
	readonly title: string;
	readonly head: string;
	readonly base: string;
	readonly body: string;
}

export interface CodeHost {
	// pushes the worktree's HEAD in `folder` to `branch` on the host
	push(folder: string, branch: string): Promise<void>;
	// the open pull request whose head is `branch`, else null
	openPull(branch: string): Promise<Pull | null>;
	createDraft(request: DraftRequest): Promise<Pull>;
	// replaces the body; the references placed before stay
	editBody(pull: Pull, body: string): Promise<void>;
	// links each Ticket not linked yet; never closes one or sets its state
	placeReferences(pull: Pull, references: readonly TicketReference[]): Promise<void>;
	comment(pull: Pull, body: string): Promise<void>;
}
