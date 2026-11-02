// The live terminal view's block: a pure function from what the reader found, the clock and a width to lines.
import type { FactoryView } from './status-reader.js';
import type { Doing, Status, TicketProgress } from './status.js';

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

const two = (n: number) => String(n).padStart(2, '0');

// 1:12, or 30:00
const countdown = (ms: number) => {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${String(Math.floor(s / 60))}:${two(s % 60)}`;
};

// 12m 04s, or 1h 02m
const elapsed = (ms: number) => {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s >= 3600) return `${String(Math.floor(s / 3600))}h ${two(Math.floor((s % 3600) / 60))}m`;
	return `${String(Math.floor(s / 60))}m ${two(s % 60)}s`;
};

const dollars = (usd: number) => `$${usd.toFixed(2)}`;
const limit = (usd: number) => `$${Number.isInteger(usd) ? String(usd) : usd.toFixed(2)}`;

const bar = (done: number, of: number, width: number) => {
	const filled = of <= 0 ? 0 : Math.min(width, Math.floor((width * done) / of));
	return '█'.repeat(filled) + '░'.repeat(width - filled);
};

function header(o: BlockOptions, view: FactoryView): string {
	const head = `nightjar  ${o.repo}`;
	const { status } = view;
	if (status === null) return `${head}${SEP}no run yet`;
	if (view.stopped || status.doing.kind === 'off') return `${head}${SEP}stopped`;
	const doing = status.doing;
	const until = (at: string | null) =>
		at === null ? '' : `${SEP}next poll ${countdown(new Date(at).getTime() - o.now.getTime())}`;
	if (doing.kind === 'idle') return `${head}${SEP}idle${until(doing.nextPollAt)}`;
	if (doing.kind === 'paused') return `${head}${SEP}paused: ${doing.why}${until(doing.until)}`;
	return `${head}${SEP}watching`;
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
	const label = `● #${doing.feature}${doing.title === undefined ? '' : ` ${doing.title}`}`;
	const right = `${elapsed(o.now.getTime() - new Date(doing.startedAt).getTime())}   ${dollars(view.featureCostUsd)}`;
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

const hash = (id: string) => `#${id}`;

function listed(status: Status): string[] {
	const names = (row: string, text: string) => `${row.padEnd(16)}${text}`;
	const queue =
		status.queue === undefined
			? 'not read yet'
			: status.queue.length === 0
				? 'empty'
				: status.queue.map((f) => `${hash(f.id)} ${f.title}`).join('   ');
	const waiting = status.waitingOnYou;
	const waits =
		waiting === undefined
			? 'not read yet'
			: waiting.items.length > 0
				? waiting.items.map((i) => `${hash(i.id)} ${i.title}: ${i.why}`).join('   ')
				: waiting.trackerCannotList
					? 'not available from this Tracker'
					: 'nothing';
	return [names('Queue', queue), names('Waiting on you', waits)];
}

function recent(view: FactoryView): string[] {
	const rows = view.completed.slice(-RECENT).reverse();
	if (rows.length === 0) return [];
	const labels = rows.map(
		({ event }) => `${hash(event.feature)}${event.title === undefined ? '' : ` ${event.title}`}`
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
		const running = !view.stopped && status.doing.kind === 'building' ? status.doing : null;
		if (running !== null) out.push('', ...current(o, view, running));
		out.push('', today(status, view.builtToday));
		// a stopped or off run has no Queue to show, only history
		if (!view.stopped && status.doing.kind !== 'off') out.push('', ...listed(status));
		const done = recent(view);
		if (done.length > 0) out.push('', ...done);
	}
	if (o.line !== null) out.push('', o.line);
	return out.map((l) => fit(l, o.width));
}
