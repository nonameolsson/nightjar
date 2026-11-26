// The Status note's words (docs/adr/0012, GLOSSARY.md): one pure function from a Feature's state to the Markdown Nightjar keeps on it.
import { FOOTER } from './footer.js';
import { plain } from './gate.js';
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
	// left out on a line that is no run of the build, such as a Source's "happened again"
	readonly state?: NoteState;
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
	// when a paused run tries the Feature again, as an ISO date; left out when nothing tries it again on its own
	readonly until?: string;
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
	// when the note was written, as an ISO date; kept in a hidden line under the headline so the next build dates this headline when it moves under Earlier runs
	readonly at?: string;
}

// A time as a teammate anywhere reads it: the date, the hour and minute, in UTC.
export const untilText = (at: string): string => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

// The state word and the sentence, the line the note opens with and the pull request body will too; a pause says until when, as "**Paused** until <time>: <why>".
export const headline = (state: NoteState, sentence: string, until?: string): string =>
	`**${STATE_WORDS[state]}**${until === undefined ? '' : ` until ${untilText(until)}`}: ${sentence}`;

// The Building sentence: which Ticket the run is on, as "Ticket 3 of 5: <title>", and the try when a passing fault has the Session run again. `ticket` is null for a Lone issue, which is its own Ticket and has no place in a list.
export function buildingSentence(at: {
	readonly ticket: { readonly place: number; readonly of: number; readonly title: string } | null;
	// the Ticket's build ended and its commit is on the branch
	readonly built?: boolean;
	readonly retry?: { readonly attempt: number; readonly of: number };
}): string {
	const retry =
		at.retry === undefined
			? ''
			: `, retrying after a fault (try ${String(at.retry.attempt)} of ${String(at.retry.of)})`;
	if (at.ticket === null) return `Nightjar is building this issue${retry}.`;
	const { place, of, title } = at.ticket;
	const which = `Ticket ${String(place)} of ${String(of)}`;
	return at.built === true ? `${which} built: ${title}` : `${which}: ${title}${retry}`;
}

export function logbookLine({ feature, session }: LogbookPointer): string {
	const where = session === null ? '' : ` · session ${session}`;
	return `Logbook: nightjar ui → #${feature}${where} (on the machine that ran it)`;
}

function ticketLine(t: NoteTicket): string {
	const why = t.why === undefined ? '' : `, ${t.why}`;
	const link = t.handBack === undefined ? '' : ` ([why](${t.handBack}))`;
	return `- #${t.id} ${t.title}: ${t.state}${why}${link}`;
}

// The most lines of a command's output a comment on the Tracker holds.
export const EXCERPT_LINES = 15;

// The end of some output, colour codes stripped, cut to at most EXCERPT_LINES lines with a line of "…" where it was cut; where the failure says itself. Empty when the output holds nothing.
export function excerptOf(output: string): string {
	const lines = plain(output)
		.replaceAll('\r\n', '\n')
		.split('\n')
		.map((l) => l.trimEnd());
	while (lines[0] === '') lines.shift();
	while (lines.at(-1) === '') lines.pop();
	if (lines.length <= EXCERPT_LINES) return lines.join('\n');
	return ['…', ...lines.slice(-(EXCERPT_LINES - 1))].join('\n');
}

// A code block that no backticks inside it can end early.
function codeBlock(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}\n${text}\n${fence}`;
}

// What a new comment on a Feature or Ticket says when it needs a person (docs/adr/0012): it stands on its own, so the notification alone says what happened and what to do.
export interface WaitingComment {
	// a hidden line the comment opens with, by which Nightjar finds it again, such as the one on a Ticket's questions
	readonly mark?: string;
	// the sentence after "Waiting on you"
	readonly sentence: string;
	// why, in one to three plain lines
	readonly cause: string;
	// the raw output behind the cause, such as a failed command's end; quoted only when no pull request holds it
	readonly output?: string;
	// where the full output is when the Feature has a pull request: the link, and the section of its body
	readonly pull?: { readonly url: string; readonly section?: string };
	readonly next: NextStep;
	readonly logbook: LogbookPointer;
}

export function waitingCommentText(c: WaitingComment): string {
	const parts = [
		`${c.mark === undefined ? '' : `${c.mark}\n`}${headline('waiting', c.sentence)}`,
		c.cause.trim()
	];
	if (c.pull !== undefined) {
		parts.push(
			c.pull.section === undefined
				? `The pull request: ${c.pull.url}`
				: `The full report is in the pull request ${c.pull.url}, in its “${c.pull.section}” section.`
		);
	} else {
		const excerpt = c.output === undefined ? '' : excerptOf(c.output);
		if (excerpt !== '') parts.push(codeBlock(excerpt));
	}
	if (c.next.length > 0) parts.push(nextStepText(c.next));
	parts.push(logbookLine(c.logbook));
	return `${parts.join('\n\n')}${FOOTER}`;
}

const day = (at: string) => at.slice(0, 10);

// the hidden line that says when the note was written
const AT_PREFIX = '<!-- nightjar:at ';
const atLine = (at: string) => `${AT_PREFIX}${at} -->`;

const earlierLine = (r: EarlierRun) =>
	`- ${day(r.at)} · ${r.state === undefined ? r.sentence : headline(r.state, r.sentence)}`;

const earlierSection = (earlier: readonly EarlierRun[]) =>
	`**Earlier runs**\n\n${earlier.map(earlierLine).join('\n')}`;

export function statusNoteText(note: StatusNote): string {
	const written = note.at === undefined ? '' : `\n${atLine(note.at)}`;
	const top = headline(note.state, note.sentence, note.until);
	const parts = [`${STATUS_MARKER}\n${top}${written}`];
	if (note.tickets.length > 0) {
		parts.push(`**Tickets**\n\n${note.tickets.map(ticketLine).join('\n')}`);
	}
	if (note.pull !== null) parts.push(`**Pull request**: ${note.pull.url}`);
	if (note.next !== null && note.next.length > 0) parts.push(nextStepText(note.next));
	if (note.earlier.length > 0) parts.push(earlierSection(note.earlier));
	parts.push(logbookLine(note.logbook));
	return `${parts.join('\n\n')}${FOOTER}`;
}

// What the headline of a Feature that no run has built says: a Source made it and it waits for the Go. It is no run, so a build does not move it under Earlier runs.
export const NOT_BUILT = 'Nightjar has not built this Feature yet; it waits for the Go.';

// A Status note read back: its headline as a run, and its Earlier runs, oldest first. There is no store for either; the note's own text is it.
export interface NoteRead {
	// null when the note's headline cannot be read
	readonly current: EarlierRun | null;
	readonly earlier: EarlierRun[];
}

const WORDS = Object.entries(STATE_WORDS) as [NoteState, string][];
const stateOf = (word: string): NoteState | undefined => WORDS.find(([, w]) => w === word)?.[0];

const HEADLINE = /^\*\*([^*]+)\*\*(?: until \d{4}-\d\d-\d\d \d\d:\d\d UTC)?: (.*)$/;
const EARLIER_LINE = /^- (\d{4}-\d\d-\d\d) · (?:\*\*([^*]+)\*\*: )?(.*)$/;
const EARLIER_SECTION = /\*\*Earlier runs\*\*\n\n- [^\n]*(?:\n- [^\n]*)*/;

// `fallbackAt` dates a headline whose note carries no time, as one written before the note kept it.
export function readStatusNote(body: string, fallbackAt: string): NoteRead {
	const text = body.replaceAll('\r\n', '\n');
	const lines = text.split('\n');
	const at = lines.find((l) => l.startsWith(AT_PREFIX))?.slice(AT_PREFIX.length, -' -->'.length);
	let current: EarlierRun | null = null;
	const match = HEADLINE.exec(lines.find((l) => l.startsWith('**')) ?? '');
	const state = stateOf(match?.[1] ?? '');
	if (match !== null && state !== undefined) {
		current = { at: at ?? fallbackAt, state, sentence: match[2] ?? '' };
	}
	const earlier: EarlierRun[] = [];
	for (const line of EARLIER_SECTION.exec(text)?.[0].split('\n').slice(2) ?? []) {
		const m = EARLIER_LINE.exec(line);
		if (m === null) continue;
		const word = m[2];
		const earlierState = word === undefined ? undefined : stateOf(word);
		// a line whose word is not a state word keeps the word in its sentence
		const said = word !== undefined && earlierState === undefined ? `**${word}**: ` : '';
		earlier.push({
			at: m[1] ?? '',
			...(earlierState === undefined ? {} : { state: earlierState }),
			sentence: `${said}${m[3] ?? ''}`
		});
	}
	return { current, earlier };
}

// The note's text with its Earlier runs set to `earlier`, the rest as it was; for a change that is not a build's, such as a Source saying it happened again.
export function withEarlier(body: string, earlier: readonly EarlierRun[]): string {
	const section = earlierSection(earlier);
	if (EARLIER_SECTION.test(body)) return body.replace(EARLIER_SECTION, () => section);
	const at = body.lastIndexOf('\n\nLogbook: ');
	if (at >= 0) return `${body.slice(0, at)}\n\n${section}${body.slice(at)}`;
	const footer = body.lastIndexOf(FOOTER);
	return footer >= 0
		? `${body.slice(0, footer)}\n\n${section}${body.slice(footer)}`
		: `${body}\n\n${section}`;
}

const AGAIN = /^Happened again, (\d+) times? since (.+)\.$/;

// A Source's "happened again" as the line under Earlier runs says it: how many times, and since when.
export const againSentence = (times: number, since: string): string =>
	`Happened again, ${String(times)} ${times === 1 ? 'time' : 'times'} since ${since}.`;

// The count and the time a "happened again" line says, or null for any other line.
export function readAgain(line: EarlierRun): { times: number; since: string } | null {
	const m = AGAIN.exec(line.sentence);
	return line.state === undefined && m !== null ? { times: Number(m[1]), since: m[2] ?? '' } : null;
}
