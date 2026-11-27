// A fault that stops a build (docs/adr/0012): where in the build it happened, whether giving the Go again is likely to help, and what the Status note and the comment that asks a person say of it. Its stack trace goes only to the Logbook, never to the Tracker.
import type { NextStep } from './next-step.js';
import { why } from './say.js';
import { PASSING_LINE } from './session.js';
import type { NoteTicket, WaitingComment } from './status-note.js';
import type { ItemId } from './tracker.js';

// Where in the build a fault happened.
export type FaultPlace =
	| { readonly kind: 'setup' }
	| { readonly kind: 'ticket'; readonly ticket: ItemId }
	// a Step of the Feature's Workflow, after `ticket` or, with null, after all Tickets
	| { readonly kind: 'step'; readonly workflow: string | null; readonly ticket: ItemId | null }
	| { readonly kind: 'review' }
	| { readonly kind: 'reviewRound'; readonly round: number }
	| { readonly kind: 'feedback' }
	// after the last Session: the push of the branch and the draft pull request
	| { readonly kind: 'pull' }
	// null before the round is counted
	| { readonly kind: 'pullFix'; readonly round: number | null }
	// null before the round is counted
	| { readonly kind: 'conflictFix'; readonly round: number | null };

// The places that are a revisit pass's fix, by what a person reads them as: no Go starts these passes, so another of the fix follows a fault in one.
const REVISIT_FIXES: Partial<Record<FaultPlace['kind'], string>> = {
	pullFix: 'Pull-check fix',
	conflictFix: 'Conflict fix'
};

// The revisit pass's fix a place is, such as "Pull-check fix", or null for a place in a build.
export const revisitFix = (kind: FaultPlace['kind'] | undefined): string | null =>
	kind === undefined ? null : (REVISIT_FIXES[kind] ?? null);

// Where a fault happened, as the words after "Nightjar stopped on a fault".
export function placeText(place: FaultPlace): string {
	switch (place.kind) {
		case 'setup':
			return 'while setting up the Feature';
		case 'ticket':
			return `while building Ticket #${place.ticket}`;
		case 'step': {
			const of = place.workflow === null ? '' : ` of the Workflow ${place.workflow}`;
			const after = place.ticket === null ? 'after all Tickets' : `after Ticket #${place.ticket}`;
			return `in a Step${of}, ${after}`;
		}
		case 'review':
			return 'in the Review';
		case 'reviewRound':
			return `in Review round ${String(place.round)}`;
		case 'feedback':
			return 'in a Feedback round';
		case 'pull':
			return 'while pushing the branch and opening the draft pull request';
		case 'pullFix':
		case 'conflictFix': {
			const fix = revisitFix(place.kind) ?? '';
			return place.round === null ? `in a ${fix}` : `in ${fix} ${String(place.round)}`;
		}
	}
}

// What the run had to show when the fault stopped it: what its Status note lists.
export interface FaultRun {
	readonly place: FaultPlace;
	readonly tickets: readonly NoteTicket[];
	// the Session the run was last in; null before its first
	readonly session: string | null;
	// the Feature's pull request, once the run knows it
	readonly pull: string | null;
}

// A fault that escaped a build, with where it happened. Its message is the fault's own, so whatever says the fault says the same as before.
export class BuildFault extends Error {
	readonly place: FaultPlace;
	readonly tickets: readonly NoteTicket[];
	readonly session: string | null;
	readonly pull: string | null;

	constructor(
		readonly fault: unknown,
		run: FaultRun
	) {
		super(why(fault), { cause: fault });
		this.name = 'BuildFault';
		this.place = run.place;
		this.tickets = run.tickets;
		this.session = run.session;
		this.pull = run.pull;
	}
}

// Whether the fault looks like one that goes away by itself, such as the network or an overloaded service, so giving the Go again is likely to help.
export const passingFault = (fault: unknown): boolean => PASSING_LINE.test(why(fault));

// The fault's own stack trace, for the Logbook alone.
export const stackOf = (fault: unknown): string | undefined => {
	const inner = fault instanceof BuildFault ? fault.fault : fault;
	return inner instanceof Error ? inner.stack : undefined;
};

// A line of a stack trace: "    at f (file.js:1:2)", "at file.js:1:2", "at <anonymous>".
const FRAME = /^\s*at\s+(?:.*:\d+(?::\d+)?\)?|.*\((?:native|<anonymous>)\)|<anonymous>)\s*$/;

// Text with every line of a stack trace taken out, so none reaches the Tracker.
export function withoutStack(text: string): string {
	const lines = text.split('\n').filter((line) => !FRAME.test(line));
	return lines.join('\n');
}

// The most of the fault's first line the headline holds.
const HEADLINE_CHARS = 200;

const short = (line: string) =>
	line.length <= HEADLINE_CHARS ? line : `${line.slice(0, HEADLINE_CHARS - 1).trimEnd()}…`;

// What the comment that asks a person, and the Status note, say of a fault: the place and the fault's first line in the headline, then whether giving the Go again is likely to help. The rest of what the fault said is quoted only when no pull request is there to point to.
export function faultAsk(o: {
	readonly fault: unknown;
	// null when the fault escaped from outside any build, so its place is not known
	readonly place: FaultPlace | null;
	readonly pull: string | null;
	readonly next: NextStep;
}): Omit<WaitingComment, 'logbook'> {
	const [first = '', ...more] = withoutStack(why(o.fault)).trim().split('\n');
	const reason = short(first.trim().replace(/\.$/, ''));
	const where = o.place === null ? '' : ` ${placeText(o.place)}`;
	const fix = revisitFix(o.place?.kind);
	const again = fix === null ? 'giving the Go again' : `another ${fix}`;
	const cause = passingFault(o.fault)
		? `This looks like a passing fault, such as the network or a service being down for a moment, so ${again} is likely to work.`
		: `This fault will probably happen again, so fix what it names before ${again}.`;
	const rest = more.join('\n').trim();
	return {
		sentence: `Nightjar stopped on a fault${where}${reason === '' ? '' : `: ${reason}`}.`,
		cause,
		...(rest === '' ? {} : { output: rest }),
		...(o.pull === null ? {} : { pull: { url: o.pull } }),
		next: o.next
	};
}
