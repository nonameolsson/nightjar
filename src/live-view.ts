// The live terminal view's block: a pure function from what the reader found, the clock and a width to lines.
import type { FactoryView } from './status-reader.js';
import { featureStart, type Doing, type Status, type TicketProgress } from './status.js';
import {
	countdown,
	dollars,
	elapsed,
	idText,
	pollAfter,
	running,
	runState,
	two
} from './view-text.js';

export interface BlockOptions {
	readonly repo: string;
	readonly width: number;
	readonly now: Date;
	// the newest line the command said
	readonly line: string | null;
}

const RECENT = 5;
const BAR_MAX = 40;
const TODAY_BAR = 20;

const SEP = '  ·  ';

const fit = (text: string, width: number) => {
	const chars = Array.from(text);
	return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
};

const limit = (usd: number) => `$${Number.isInteger(usd) ? String(usd) : usd.toFixed(2)}`;

const bar = (done: number, of: number, width: number) => {
	const filled = of <= 0 ? 0 : Math.min(width, Math.floor((width * done) / of));
	return '█'.repeat(filled) + '░'.repeat(width - filled);
};

function header(o: BlockOptions, view: FactoryView): string {
	const head = `nightjar  ${o.repo}`;
	const { status } = view;
	if (status === null) return `${head}${SEP}no run yet`;
	// the block ends on stopped when the run ends, as well as when its process died
	const state = runState(view);
	if (state === 'off' || state === 'stopped') return `${head}${SEP}stopped`;
	const doing = status.doing;
	const until = (at: string | null) =>
		at === null ? '' : `${SEP}next poll ${countdown(new Date(at).getTime() - o.now.getTime())}`;
	if (doing.kind === 'idle') return `${head}${SEP}idle${until(doing.nextPollAt)}`;
	if (doing.kind === 'paused') return `${head}${SEP}paused: ${doing.why}${until(doing.until)}`;
	const after = pollAfter(view);
	return `${head}${SEP}watching${after === null ? '' : `${SEP}next poll after ${after}`}`;
}

type Building = Extract<Doing, { kind: 'building' }>;

function progressText(doing: Building, tickets: readonly TicketProgress[] | undefined): string {
	const round =
		doing.round === null ? '' : `, round ${String(doing.round)}/${String(doing.rounds)}`;
	const step = `${doing.step}${round}`;
	if (tickets === undefined) return step;
	const built = tickets.filter((t) => t.state === 'built').length;
	const at = tickets.findIndex((t) => t.id === doing.ticket);
	const position =
		doing.ticket === null || at < 0
			? `${String(built)}/${String(tickets.length)} Tickets built`
			: `Ticket ${String(at + 1)}/${String(tickets.length)}`;
	return `${position}  ${step}`;
}

function current(o: BlockOptions, view: FactoryView, doing: Building): string[] {
	const label = `● ${idText(doing.feature)}${doing.title === undefined ? '' : ` ${doing.title}`}`;
	const right = `${elapsed(o.now.getTime() - new Date(featureStart(doing)).getTime())}   ${dollars(view.featureCostUsd)}`;
	const room = Math.max(1, o.width - Array.from(right).length - 1);
	const left = fit(label, room);
	const gap = ' '.repeat(Math.max(1, o.width - Array.from(left).length - Array.from(right).length));
	const lines = [`${left}${gap}${right}`, `  ${progressText(doing, doing.tickets)}`];
	const { tickets } = doing;
	if (tickets !== undefined && tickets.length > 0) {
		const built = tickets.filter((t) => t.state === 'built').length;
		lines.push(`  ${bar(built, tickets.length, Math.min(BAR_MAX, o.width - 2))}`);
	}
	const newest = view.tail.at(-1);
	if (newest !== undefined) lines.push(`  ▸ ${newest}`);
	return lines;
}

function today(status: Status, built: number): string {
	const spent = `${dollars(status.spentTodayUsd)} / ${limit(status.dailyUsd)}`;
	const meter = bar(status.spentTodayUsd, status.dailyUsd, TODAY_BAR);
	return `Today   ${spent}  ${meter}  ${String(built)} Tickets built`;
}

function listed(status: Status): string[] {
	const names = (row: string, text: string) => `${row.padEnd(16)}${text}`;
	const queue =
		status.queue === undefined
			? 'not read yet'
			: status.queue.length === 0
				? 'empty'
				: status.queue.map((f) => `${idText(f.id)} ${f.title}`).join('   ');
	const waiting = status.waitingOnYou;
	const items = waiting?.items.map((i) => `${idText(i.id)} ${i.title}: ${i.why}`) ?? [];
	if (waiting?.trackerCannotList === true) items.push('not available from this Tracker');
	const waits =
		waiting === undefined ? 'not read yet' : items.length > 0 ? items.join('   ') : 'nothing';
	return [names('Queue', queue), names('Waiting on you', waits)];
}

function recent(view: FactoryView): string[] {
	const rows = view.completed.slice(-RECENT).reverse();
	if (rows.length === 0) return [];
	const labels = rows.map(
		({ event }) => `${idText(event.feature)}${event.title === undefined ? '' : ` ${event.title}`}`
	);
	const wide = Math.max(...labels.map((l) => Array.from(l).length));
	return [
		'Recent',
		...rows.map(({ event, costUsd }, i) => {
			const at = new Date(event.at);
			const mark = event.kind === 'pull' ? '✓' : '✗';
			const outcome = event.kind === 'pull' ? 'draft PR' : event.why;
			const cost = costUsd > 0 ? `  ${dollars(costUsd)}` : '';
			return `  ${mark} ${two(at.getHours())}:${two(at.getMinutes())}  ${(labels[i] ?? '').padEnd(wide)}  ${outcome}${cost}`;
		})
	];
}

// The block a view shows, one string per line, none wider than `width`.
export function renderBlock(view: FactoryView, o: BlockOptions): string[] {
	const out: string[] = [header(o, view)];
	const { status } = view;
	if (status !== null) {
		const building = running(view) && status.doing.kind === 'building' ? status.doing : null;
		if (building !== null) out.push('', ...current(o, view, building));
		out.push('', today(status, view.builtToday));
		if (running(view)) out.push('', ...listed(status));
		const done = recent(view);
		if (done.length > 0) out.push('', ...done);
	}
	if (o.line !== null) out.push('', o.line);
	return out.map((l) => fit(l, o.width));
}
