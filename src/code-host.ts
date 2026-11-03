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

export type FeedbackKind = 'comment' | 'review' | 'check';

// Something said on a pull request that a Coding agent may be asked to answer.
export interface Feedback {
	// the kind, a colon and the host's own id (`comment:123`, `review:45`, `check:678`): ids from different lists of one host never clash
	readonly id: string;
	readonly kind: FeedbackKind;
	// the person, or for a check the app that ran it
	readonly author: string;
	// a check's is its name and the end of its output
	readonly body: string;
	readonly at: string;
	// whether its author is trusted, so it may reach the Coding agent
	readonly trusted: boolean;
	// a line comment: its file, and its line while the line is on the head commit
	readonly path?: string;
	readonly line?: number;
	// a line comment on a line the head commit no longer has; it comes with `path` and no `line`
	readonly outdated?: true;
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
	// Optional, and both or neither: a Code host without them gets no Feedback rounds.
	// Every line comment, conversation comment and review with a body, and every failed check on the head commit, all pages of each.
	// Never Nightjar's own words: whatever ends with the footer is left out, whoever wrote it.
	feedback?(pull: Pull): Promise<Feedback[]>;
	// Answers one piece of feedback by its id; the body always ends with the footer.
	// A line comment is answered in its thread, anything else in the pull request's conversation with the start of it quoted.
	reply?(pull: Pull, feedbackId: string, body: string): Promise<void>;
}
