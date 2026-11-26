// The Status note's words (docs/adr/0012, GLOSSARY.md): one pure function from a Feature's state to the Markdown Nightjar keeps on it.
import { FOOTER } from './footer.js';
import { nextStepText, type NextStep } from './next-step.js';
import type { TicketProgress } from './status-shape.js';
import { STATUS_MARKER, type ItemId } from './tracker.js';

// The Board's state words, one table for the Status note, the pull request and the page, so none of them drifts from the others.
export const STATE_WORDS = {
	building: 'Building',
	waiting: 'Waiting on you',
	paused: 'Paused',
	pull: 'Draft PR open',
	stopped: 'Stopped'
} as const;

export type NoteState = keyof typeof STATE_WORDS;

// A Ticket as the note lists it: its state, and the link to the comment that handed it back, when one did.
export interface NoteTicket extends TicketProgress {
	readonly handBack?: string;
}

// One earlier run of the Feature, as one line under Earlier runs.
export interface EarlierRun {
	// when it ended, as an ISO date
	readonly at: string;
	readonly state: NoteState;
	readonly sentence: string;
}

// Where the Feature's Logbook is, which the note names and never holds.
export interface LogbookPointer {
	readonly feature: ItemId;
	// the Session the run was last in; null before its first
	readonly session: string | null;
}

// Everything a Status note says, in the order it says it.
export interface StatusNote {
	readonly state: NoteState;
	// one sentence that says what the state means for this Feature now
	readonly sentence: string;
	// a Lone issue is its own Ticket, so it lists none
	readonly tickets: readonly NoteTicket[];
	readonly pull: { readonly url: string } | null;
	// null when there is nothing for a person to do
	readonly next: NextStep | null;
	// oldest first
	readonly earlier: readonly EarlierRun[];
	readonly logbook: LogbookPointer;
}

// The state word and the sentence, the line the note opens with and the pull request body will too.
export const headline = (state: NoteState, sentence: string): string =>
	`**${STATE_WORDS[state]}**: ${sentence}`;

export function logbookLine({ feature, session }: LogbookPointer): string {
	const where = session === null ? '' : ` · session ${session}`;
	return `Logbook: nightjar ui → #${feature}${where} (on the machine that ran it)`;
}

function ticketLine(t: NoteTicket): string {
	const why = t.why === undefined ? '' : `, ${t.why}`;
	const link = t.handBack === undefined ? '' : ` ([why](${t.handBack}))`;
	return `- #${t.id} ${t.title}: ${t.state}${why}${link}`;
}

const day = (at: string) => at.slice(0, 10);

export function statusNoteText(note: StatusNote): string {
	const parts = [`${STATUS_MARKER}\n${headline(note.state, note.sentence)}`];
	if (note.tickets.length > 0) {
		parts.push(`**Tickets**\n\n${note.tickets.map(ticketLine).join('\n')}`);
	}
	if (note.pull !== null) parts.push(`**Pull request**: ${note.pull.url}`);
	if (note.next !== null && note.next.length > 0) parts.push(nextStepText(note.next));
	if (note.earlier.length > 0) {
		const lines = note.earlier.map((r) => `- ${day(r.at)} · ${headline(r.state, r.sentence)}`);
		parts.push(`**Earlier runs**\n\n${lines.join('\n')}`);
	}
	parts.push(logbookLine(note.logbook));
	return `${parts.join('\n\n')}${FOOTER}`;
}
