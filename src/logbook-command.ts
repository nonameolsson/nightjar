// `nightjar logbook`: a Feature's Logbook, or one Session, printed from .factory/ alone. It makes no call to a Tracker, a Code host or the Coding agent, so it needs no login.
import { run, type Env } from './git.js';
import {
	readLogbook,
	readSession,
	type LoggedSession,
	type LogbookView,
	type SessionView
} from './logbook-reader.js';
import { decisionText } from './logbook-text.js';
import type { LogbookEntry } from './logbook.js';
import type { SignalNames } from './signals.js';
import { linksFor } from './ui-links.js';
import { dollars, elapsed, idText, KIND_TEXT } from './view-text.js';

export const LOGBOOK_USAGE = `usage: nightjar logbook FEATURE
       nightjar logbook --session ID [--full]

  FEATURE       print that Feature's Logbook: each Session and each decision of Nightjar's, in order, with every Session's transcript path
  --session ID  print one Session: the Coding agent's text and a line per tool call
  --full        with --session: add each tool call's result`;

export interface LogbookHost {
	readonly cwd: string;
	readonly env: Env;
}

type LogbookArgs =
	| { readonly kind: 'feature'; readonly feature: string }
	| { readonly kind: 'session'; readonly session: string; readonly full: boolean };

// A Feature id as `nightjar FEATURE` takes it: 42, #42 or PROJ-123.
const FEATURE_ID = /^#?[A-Za-z0-9][\w.-]*$/;

// The arguments, or the line that says what is wrong with them.
function parseLogbookArgs(argv: readonly string[]): LogbookArgs | string {
	let feature: string | undefined;
	let session: string | undefined;
	let full = false;
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i] ?? '';
		if (a === '--full') full = true;
		else if (a === '--session') {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) return '--session needs a Session id';
			if (session !== undefined) return 'choose one Session';
			session = value;
			i += 1;
		} else if (FEATURE_ID.test(a)) {
			if (feature !== undefined) return 'choose one Feature';
			feature = a.replace(/^#/, '');
		} else return `unknown argument ${a}`;
	}
	if (feature !== undefined && session !== undefined)
		return 'choose a Feature or --session, not both';
	if (session !== undefined) return { kind: 'session', session, full };
	if (full) return '--full goes with --session only';
	if (feature === undefined) return 'say which Feature, or --session ID';
	return { kind: 'feature', feature };
}

const two = (n: number) => String(n).padStart(2, '0');

// A time as the machine's clock shows it, to the second; a time that does not parse as it is.
function stamp(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const sessionsText = (n: number) => (n === 1 ? '1 Session' : `${String(n)} Sessions`);

const indent = (text: string, by: string) =>
	text
		.split('\n')
		.map((l) => `${by}${l}`)
		.join('\n');

function sessionLines(s: LoggedSession): string[] {
	const kind = KIND_TEXT[s.kind] ?? s.kind;
	const ticket = s.ticket === null ? 'the whole Feature' : `Ticket ${idText(s.ticket)}`;
	const took = s.durationMs === undefined ? [] : [elapsed(s.durationMs)];
	return [
		`${stamp(s.at)}  Session ${s.id}: ${[kind, ticket, s.outcome, dollars(s.costUsd), ...took].join(', ')}`,
		`    transcript: ${s.transcript}`
	];
}

function decisionLines(entry: LogbookEntry, signals: SignalNames): string[] {
	const said = decisionText(entry, signals);
	const ticket = entry.ticket === undefined ? '' : `Ticket ${idText(entry.ticket)}: `;
	const lines = [`${stamp(entry.at)}  ${ticket}${said.line}`];
	if (said.more !== undefined) {
		lines.push(`    ${said.more.label}:`, indent(said.more.text, '      '));
	}
	return lines;
}

// The Logbook as lines, oldest first.
export function logbookLines(book: LogbookView, signals: SignalNames): string[] {
	const sessions = book.items.flatMap((i) => (i.kind === 'session' ? [i.session] : []));
	const cost = sessions.reduce((sum, s) => sum + s.costUsd, 0);
	const lines = [
		`Logbook of ${idText(book.feature)}: ${sessionsText(sessions.length)}, ${dollars(cost)}`
	];
	if (!book.recorded) {
		lines.push(
			"Builds before the Logbook did not record Nightjar's decisions, so this shows the Feature's Sessions only."
		);
	}
	for (const item of book.items) {
		if (item.kind === 'session') lines.push(...sessionLines(item.session));
		else lines.push(...decisionLines(item.entry, signals));
	}
	return lines;
}

// One Session as lines: what the ledger says of each run of it, then its transcript, with the tool results only in full.
export function sessionPrint(view: SessionView, full: boolean): string[] {
	const lines = [`Session ${view.id}`];
	if (view.runs.length === 0) lines.push('The ledger has no line for this Session.');
	for (const ran of view.runs) {
		const kind = KIND_TEXT[ran.kind] ?? ran.kind;
		const ticket = ran.ticket === null ? 'the whole Feature' : `Ticket ${idText(ran.ticket)}`;
		const took = ran.durationMs === undefined ? [] : [elapsed(ran.durationMs)];
		const end = [ran.outcome, dollars(ran.costUsd), ...took];
		// a Retro works on no Feature, so its line names none
		const line =
			ran.kind === 'retro'
				? [kind, ...end].join(', ')
				: `Feature ${idText(ran.feature)}: ${[kind, ticket, ...end].join(', ')}`;
		lines.push(`${stamp(ran.at)}  ${line}`);
	}
	lines.push('');
	const shown = view.lines.filter((l) => full || l.kind !== 'result');
	if (shown.length === 0) lines.push('The transcript has nothing to show.');
	for (const l of shown) {
		if (l.kind === 'text') lines.push(l.text);
		else if (l.kind === 'tool') lines.push(`  ${l.text}`);
		else lines.push('  Result:', indent(l.text, '    '));
	}
	return lines;
}

export async function runLogbookCommand(
	argv: readonly string[],
	host: LogbookHost
): Promise<number> {
	const args = parseLogbookArgs(argv);
	if (typeof args === 'string') {
		console.error(`nightjar: ${args}\n\n${LOGBOOK_USAGE}`);
		return 2;
	}
	const top = await run('git', ['rev-parse', '--show-toplevel'], host.cwd, host.env);
	if (!top.ok) {
		console.error('nightjar: not inside a git checkout; run logbook in the repo.');
		return 2;
	}
	const root = top.out.trim();
	if (args.kind === 'session') {
		const view = readSession(root, args.session);
		if (view === null) {
			console.error(`nightjar: no transcript for Session ${args.session} in .factory/logs/.`);
			return 1;
		}
		console.log(sessionPrint(view, args.full).join('\n'));
		return 0;
	}
	const book = readLogbook(root, args.feature);
	if (book.items.length === 0) {
		console.error(
			`nightjar: nothing recorded for Feature ${idText(args.feature)} in .factory/; nothing was built for it on this machine.`
		);
		return 1;
	}
	console.log(logbookLines(book, linksFor(root, null).signals).join('\n'));
	return 0;
}
