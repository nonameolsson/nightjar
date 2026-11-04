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

// One failed Pull check, as the Code host shows a person why it is red.
export interface FailedCheck {
	// the check's name, such as `CI / test`
	readonly check: string;
	// the job that failed, and its step that failed; empty when the Code host names none
	readonly job: string;
	readonly step: string;
	// the end of the failed job's log, cut to its last lines
	readonly logTail: string;
}

// The Pull checks on a pull request's head commit.
export interface PullChecks {
	// whether any check on the head commit has not finished yet
	readonly pending: boolean;
	// every check that finished red, required or not
	readonly failed: readonly FailedCheck[];
}

// An open draft pull request on one of Nightjar's branches, as the revisit pass reads it.
export interface NightjarDraft {
	readonly pull: Pull;
	// its head branch, which starts with Nightjar's branch prefix
	readonly branch: string;
	// the commit its head branch points at, which its Pull checks ran on
	readonly headCommit: string;
	readonly body: string;
	readonly checks: PullChecks;
	// whether an account other than the signed-in one reviewed or commented on it
	readonly personEngaged: boolean;
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
	// optional, so a Code host module written before it still loads: the open draft pull requests whose head branch starts with Nightjar's branch prefix, oldest first; a Code host without it gets no Pull-check pass
	nightjarDrafts?(): Promise<NightjarDraft[]>;
	// Optional, both or neither. Every page of each list; whatever ends with the footer is left out, whoever wrote it.
	feedback?(pull: Pull): Promise<Feedback[]>;
	// A line comment is answered in its thread, anything else in the conversation quoting its start; the body ends with the footer.
	reply?(pull: Pull, feedbackId: string, body: string): Promise<void>;
}
