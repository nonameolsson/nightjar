// `nightjar ui`: a read-only page about the repo, drawn from .factory/ alone, pushed to the browser as server-sent events.
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { lastRepo, ledgerPath } from './ledger.js';
import { NEEDS_A_PERSON, NEEDS_INFO } from './plan.js';
import { BANNER } from './ui-banner.js';
import { linksFor, NO_LINKS, type Links } from './ui-links.js';
import { readFactory, type Completed, type FactoryView } from './status-reader.js';
import type { Doing, Queued, TicketCounts, TicketProgress, WaitingItem } from './status-shape.js';
import { featureStart } from './status.js';
import {
	countdown,
	dollars,
	elapsed,
	idText,
	pollAfter,
	running,
	runState,
	stepText,
	two
} from './view-text.js';

export const UI_PORT = 4545;
const HOST = '127.0.0.1';

export interface Ui {
	readonly address: string;
	readonly port: number;
	readonly close: () => Promise<void>;
}

export interface UiOptions {
	// the repo root; the page reads its .factory/ and nothing else
	readonly root: string;
	readonly port: number;
	readonly now?: () => Date;
	// whether a pid is alive; the machine's own answer unless a spec passes one
	readonly alive?: (pid: number) => boolean;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

const EXTERNAL = 'target="_blank" rel="noreferrer noopener"';

// An id, as a link to its page on the Tracker when the page knows one
const idHtml = (id: string, links: Links = NO_LINKS) => {
	const text = escape(idText(id));
	const href = links.issue(id);
	return href === null
		? text
		: `<a class="ext" href="${escape(href)}" ${EXTERNAL} title="Open ${text} on ${links.tracker ?? 'the Tracker'}">${text}</a>`;
};
const clock = (iso: string) =>
	new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function header(repo: string, view: FactoryView): string {
	const doing = view.status?.doing;
	const after = pollAfter(view);
	const poll =
		after !== null
			? ` <span>next poll after ${escape(after)}</span>`
			: doing?.kind === 'idle' && running(view)
				? ` <span>next poll <time data-until="${escape(doing.nextPollAt)}"></time></span>`
				: doing?.kind === 'paused' && running(view)
					? ` <span>${escape(doing.why)}${doing.until === null ? '' : ` until <time datetime="${escape(doing.until)}">${clock(doing.until)}</time>`}</span>`
					: '';
	return `<header><h1>${escape(repo)}</h1> <span class="state">${runState(view)}</span>${poll}</header>`;
}

function cards(view: FactoryView): string {
	const status = view.status;
	const spent =
		status === null
			? 'no spend recorded'
			: `${dollars(status.spentTodayUsd)} of ${dollars(status.dailyUsd)}`;
	const waiting = status?.waitingOnYou?.items.length;
	return `<section id="cards"><div class="stat"><span>spent today</span> ${spent}</div><div class="stat"><span>built today</span> <b>${String(view.builtToday)}</b></div><div class="stat"><span>waiting on you</span> <b>${waiting === undefined ? '-' : String(waiting)}</b></div></section>`;
}

function queue(view: FactoryView, links: Links): string {
	const status = view.status;
	let body: string;
	if (!running(view)) body = OFF;
	else if (status?.queue === undefined) body = '<p class="empty">not read yet</p>';
	else if (status.queue.length === 0) body = emptyQueue(links);
	else
		body = `<ul>${status.queue.map((q) => `<li>${idHtml(q.id, links)} ${escape(q.title)}</li>`).join('')}</ul>`;
	const refreshed =
		running(view) && status?.refreshedAt !== undefined
			? ` <small>refreshed ${clock(status.refreshedAt)}</small>`
			: '';
	return `<section id="queue"><h2>Queue${refreshed}</h2>${body}</section>`;
}

// Where a build stands, in words: `Ticket 2 of 3, step, round 1 of 2`.
function stepLine(doing: Building): string {
	const tickets = doing.tickets ?? [];
	const at = tickets.findIndex((t) => t.id === doing.ticket);
	const where = at < 0 ? '' : `Ticket ${String(at + 1)} of ${String(tickets.length)}, `;
	const round =
		doing.round === null || doing.rounds === null
			? ''
			: `, round ${String(doing.round)} of ${String(doing.rounds)}`;
	return `${where}${stepText(doing.step)}${round}`;
}

// One `<li>` per Ticket, in order, with its state and why.
function ticketItems(tickets: readonly TicketProgress[], links: Links): string {
	return tickets
		.map(
			(t) =>
				`<li class="${t.state}">${idHtml(t.id, links)} ${escape(t.title)} <small>${t.state === 'waiting' ? 'needs a person' : t.state}${t.why === undefined ? '' : `: ${escape(t.why)}`}</small></li>`
		)
		.join('');
}

function current(view: FactoryView, links: Links): string {
	const doing = view.status?.doing;
	let body = '<p class="empty">nothing is being built</p>';
	if (doing?.kind === 'building' && running(view)) {
		const tickets = doing.tickets ?? [];
		const progress = ticketItems(tickets, links);
		const tail = view.tail.map(escape).join('\n');
		body =
			`<p>${idHtml(doing.feature, links)}${doing.title === undefined ? '' : ` ${escape(doing.title)}`} <time data-since="${escape(featureStart(doing))}"></time> ${dollars(view.featureCostUsd)}</p>` +
			`<p>${stepLine(doing)}</p>` +
			(progress === '' ? '' : `<ul>${progress}</ul>`) +
			(tail === '' ? '' : `<pre>${tail}</pre>`);
	}
	return `<section id="current"><h2>Current build</h2>${body}</section>`;
}

function waiting(view: FactoryView, links: Links): string {
	const found = view.status?.waitingOnYou;
	let body: string;
	if (!running(view)) body = OFF;
	else if (found === undefined) body = '<p class="empty">not read yet</p>';
	else {
		const note = found.trackerCannotList
			? '<p class="empty">not available from this Tracker</p>'
			: found.items.length === 0
				? '<p class="empty">nothing</p>'
				: '';
		const items = found.items
			.map((i) => `<li>${idHtml(i.id, links)} ${escape(i.title)}: ${escape(i.why)}</li>`)
			.join('');
		body = note + (items === '' ? '' : `<ul>${items}</ul>`);
	}
	return `<section id="waiting"><h2>Waiting on you</h2>${body}</section>`;
}

// a javascript: link in a pull request url would run on click
const safeUrl = (url: string) => /^https?:\/\//.test(url);

function completed(view: FactoryView, links: Links): string {
	const rows = view.completed
		.map(
			({ event, costUsd }) =>
				`<li>${idHtml(event.feature, links)}${event.title === undefined ? '' : escape(` ${event.title}`)} ${outcomeHtml(event)} ${dollars(costUsd)}</li>`
		)
		.reverse()
		.join('');
	return `<section id="completed"><h2>Completed</h2>${rows === '' ? '<p class="empty">nothing has finished yet</p>' : `<ul>${rows}</ul>`}</section>`;
}

// A draft pull request link, or the failure and why; a url that is not http stays text
const outcomeHtml = (event: Completed['event']) =>
	event.kind === 'pull'
		? safeUrl(event.url)
			? `<a class="act ext" href="${escape(event.url)}" ${EXTERNAL}>draft pull request</a>`
			: escape(event.url)
		: `failed: ${escape(event.why)}`;

// how long the build took; null for an event with no start, or a start that does not read
function tookMs(event: Completed['event']): number | null {
	const took =
		event.startedAt === undefined ? NaN : Date.parse(event.at) - Date.parse(event.startedAt);
	return Number.isNaN(took) ? null : took;
}

type Building = Extract<Doing, { kind: 'building' }>;

// A Feature as a view draws it; every view reads this one list.
interface FeatureCard {
	readonly id: string;
	readonly title?: string;
	// the Tickets that wait on a person, with why
	readonly waitingTickets: readonly WaitingItem[];
	// Tickets built of the Feature's Tickets; null when there is no count to show
	readonly progress: Progress | null;
}
interface QueuedCard extends FeatureCard {
	readonly state: 'queue';
	// null when the count could not be read; undefined when the Tracker cannot count
	readonly ticketCounts: TicketCounts | null | undefined;
	// null when there is nothing to estimate from
	readonly estimateMs: number | null;
}

const estimateHtml = (ms: number | null) =>
	ms === null ? '' : `<time class="est">${elapsed(ms)}</time> <small>est.</small>`;
interface BuildingCard extends FeatureCard {
	readonly state: 'building';
	readonly doing: Building;
}
interface Progress {
	readonly built: number;
	readonly total: number;
}
interface WaitingCard extends FeatureCard {
	readonly state: 'waiting';
	readonly why: string;
}
interface CompletedCard extends FeatureCard {
	readonly state: 'completed';
	readonly done: Completed;
}

const progressText = (p: Progress | null) =>
	p === null ? '?' : `${String(p.built)} of ${String(p.total)}`;

// A Ticket as an egg: built, being built, needs a person, or still waiting its turn
type Egg = 'built' | 'building' | 'need' | 'waiting';
const EGGS_SHOWN = 16;

const EGG_OF: Record<TicketProgress['state'], Egg> = {
	built: 'built',
	building: 'building',
	waiting: 'need'
};

// `k of N built` under a row of eggs, one per Ticket; "?" and no eggs without a count
function progressHtml(p: Progress | null, tickets?: readonly TicketProgress[]): string {
	if (p === null) return '<p class="meta progress">count unknown</p>';
	const slots: Egg[] =
		tickets !== undefined && tickets.length > 0
			? tickets.map((t) => EGG_OF[t.state])
			: Array.from({ length: p.total }, (_, i): Egg => (i < p.built ? 'built' : 'waiting'));
	const more =
		slots.length > EGGS_SHOWN ? `<small>+${String(slots.length - EGGS_SHOWN)}</small>` : '';
	const eggs = slots
		.slice(0, EGGS_SHOWN)
		.map((s) => `<i class="slot"><i class="egg ${s}"></i></i>`)
		.join('');
	return `<span class="eggs" role="img" aria-label="${progressText(p)} built">${eggs}${more}</span><p class="meta progress">${progressText(p)} built</p>`;
}

interface Features {
	// each is undefined while Nightjar is off or has not read it yet
	readonly queue: readonly QueuedCard[] | undefined;
	readonly building: BuildingCard | null;
	readonly waiting: readonly WaitingCard[] | undefined;
	readonly trackerCannotList: boolean;
	// newest first
	readonly completed: readonly CompletedCard[];
}

// The one list of Features, built from what the reader gives.
function features(view: FactoryView): Features {
	const status = view.status;
	const doing = status?.doing;
	const on = running(view);
	const tickets = doing?.kind === 'building' ? (doing.tickets ?? []) : [];
	const building: BuildingCard | null =
		doing?.kind === 'building' && on
			? {
					state: 'building',
					id: doing.feature,
					...(doing.title === undefined ? {} : { title: doing.title }),
					waitingTickets: tickets
						.filter((t) => t.state === 'waiting')
						.map((t) => ({ kind: 'ticket', id: t.id, title: t.title, why: t.why ?? '' })),
					// from its own Ticket list, which is empty until the Tickets are planned
					progress:
						tickets.length === 0
							? null
							: { built: tickets.filter((t) => t.state === 'built').length, total: tickets.length },
					doing
				}
			: null;
	const found = on ? status?.waitingOnYou : undefined;
	// a failure's total is known only while the Queue or Waiting on you counts that Feature again
	const totals = new Map<string, number>();
	if (on) {
		for (const q of status?.queue ?? []) if (q.ticketCounts) totals.set(q.id, q.ticketCounts.total);
		for (const i of found?.items ?? [])
			if (i.kind === 'feature' && i.ticketCounts) totals.set(i.id, i.ticketCounts.total);
	}
	const completedCard = (done: Completed): CompletedCard => {
		const built = done.builtTickets ?? 0;
		const total = totals.get(done.event.feature) ?? null;
		return {
			state: 'completed',
			id: done.event.feature,
			...(done.event.title === undefined ? {} : { title: done.event.title }),
			waitingTickets: [],
			done,
			// a pull request says what its branch holds; this run's sessions may have built only part of it
			progress:
				done.event.kind === 'pull'
					? (done.event.tickets ?? null)
					: total === null
						? null
						: { built: Math.min(built, total), total }
		};
	};
	const completed = view.completed.map(completedCard).reverse();
	let waiting: WaitingCard[] | undefined;
	if (found !== undefined) {
		waiting = found.items
			.filter((i) => i.kind === 'feature')
			.map((i) => ({
				state: 'waiting',
				id: i.id,
				title: i.title,
				why: i.why,
				waitingTickets: [],
				progress: i.ticketCounts
					? { built: i.ticketCounts.closed, total: i.ticketCounts.total }
					: null
			}));
		// an older file names no Feature on a Ticket: it is the one being built, else the one that just ended
		const owner = (building ?? completed[0])?.id ?? '';
		const titleOf = (id: string) =>
			[building, ...completed].find((c) => c?.id === id && c.title !== undefined)?.title;
		const byFeature = new Map<string, WaitingItem[]>();
		for (const t of found.items.filter((i) => i.kind === 'ticket')) {
			const id = t.feature ?? owner;
			byFeature.set(id, [...(byFeature.get(id) ?? []), t]);
		}
		for (const [id, tickets] of byFeature) {
			const at = waiting.findIndex((w) => w.id === id);
			const own = at < 0 ? undefined : waiting[at];
			const title = titleOf(id);
			if (own !== undefined) waiting[at] = { ...own, waitingTickets: tickets };
			else
				waiting.push({
					state: 'waiting',
					id,
					...(title === undefined ? {} : { title }),
					// Nightjar gives needs info to a Feature whenever one of its Tickets waits
					why: 'needs info',
					waitingTickets: tickets,
					progress: null
				});
		}
	}
	const queued = (q: Queued): QueuedCard => ({
		state: 'queue',
		id: q.id,
		title: q.title,
		waitingTickets: [],
		ticketCounts: q.ticketCounts,
		progress: q.ticketCounts ? { built: 0, total: q.ticketCounts.total } : null,
		// the median Ticket duration times the Feature's Tickets; none without history or a count
		estimateMs:
			view.medianTicketMs == null || !q.ticketCounts
				? null
				: view.medianTicketMs * q.ticketCounts.total
	});
	const queue = on ? status?.queue?.map(queued) : undefined;
	return {
		queue,
		building,
		waiting,
		trackerCannotList: found?.trackerCannotList ?? false,
		completed
	};
}

const feature = (card: FeatureCard, links: Links) =>
	`<b>${card.id === '' ? '' : idHtml(card.id, links)}</b> ${card.title === undefined ? '' : escape(card.title)}`;

const waitingTicketsHtml = (card: FeatureCard, links: Links) =>
	card.waitingTickets.length === 0
		? ''
		: `<ul class="tickets">${card.waitingTickets.map((t) => `<li class="waiting">${idHtml(t.id, links)} ${escape(t.title)} <small>${escape(t.why)}</small></li>`).join('')}</ul>`;

// One Feature as a nest in the ledger: who, its egg row, where it stands, its clock, and what hangs beneath it.
function nest(
	cls: string,
	card: FeatureCard,
	links: Links,
	eggs: string,
	now: string,
	meta: string,
	beneath = ''
): string {
	return `<article class="entry ${cls}"><div class="who">${feature(card, links)}</div><div class="eggcell">${eggs}</div><div class="now">${now}</div><div class="clock">${meta}</div>${beneath}</article>`;
}

function buildingCard(card: BuildingCard, links: Links): string {
	const { doing } = card;
	const tickets = doing.tickets ?? [];
	return nest(
		'building',
		card,
		links,
		card.progress === null ? '' : progressHtml(card.progress, tickets),
		`<p class="label">Building</p><p>${stepLine(doing)}</p>`,
		`<time data-since="${escape(featureStart(doing))}"></time>`
	);
}

// What the one build in flight is doing: its Tickets in order, its clock and cost, and the tail of its Session.
function detail(card: BuildingCard, view: FactoryView, links: Links): string {
	const { doing } = card;
	const tickets = doing.tickets ?? [];
	const steps = ticketItems(tickets, links);
	const tail = view.tail.map(escape).join('\n');
	return (
		`<aside class="detail" aria-label="Building now"><p class="dk"><i></i>Building now</p>` +
		`<h3>${feature(card, links)}</h3><p class="sub">${stepLine(doing)}</p>` +
		(steps === '' ? '' : `<ol class="steps">${steps}</ol>`) +
		`<div class="meters"><div><small>Elapsed</small><b><time data-since="${escape(featureStart(doing))}"></time></b></div><div><small>Cost</small><b>${dollars(view.featureCostUsd)}</b></div></div>` +
		(tail === '' ? '' : `<pre>${tail}</pre>`) +
		'</aside>'
	);
}

// A Feature not yet started: its Ticket count, `0 of N` and its eggs; "?" and no eggs when the count failed; nothing when the Tracker cannot count.
function queuedCard(card: QueuedCard, links: Links): string {
	const counts = card.ticketCounts;
	let count = '';
	if (counts === null) count = '<p class="meta count">? Tickets</p>';
	else if (counts !== undefined)
		count = `<p class="meta count">${String(counts.total)} ${counts.total === 1 ? 'Ticket' : 'Tickets'}</p>${progressHtml(card.progress)}`;
	const est = card.estimateMs === null ? '' : estimateHtml(card.estimateMs);
	return nest('queue', card, links, count, '<p class="label">Queued</p>', est);
}

function completedCard(card: CompletedCard, links: Links): string {
	const { event, costUsd } = card.done;
	const took = tookMs(event);
	const duration = took === null ? '' : `<time class="took">${elapsed(took)}</time> `;
	return nest(
		event.kind === 'failed' ? 'failed' : 'pulled',
		card,
		links,
		progressHtml(card.progress),
		`<p class="label">${event.kind === 'failed' ? 'Failed' : 'Done'}</p><p>${event.kind === 'failed' ? escape(event.why) : outcomeHtml(event)}</p>`,
		`${duration}${dollars(costUsd)}`
	);
}

function group(state: string, name: string, count: number | null, body: string): string {
	const shown = count === null ? '' : `<i class="tally">${String(count)}</i>`;
	return `<section class="mat" data-state="${state}"><div class="tab"><h2>${name}</h2>${shown}</div><div class="lines">${body}</div></section>`;
}

const copyable = (command: string) =>
	`<code>${escape(command)}</code> <button type="button" class="copy" data-copy="${escape(command)}">copy</button>`;

const hint = (html: string) => ` <span class="hint">${html}</span>`;

const OFF = `<p class="empty">not known while nightjar is off${hint(`Start it in this repo: ${copyable('nightjar --watch')}`)}</p>`;

function emptyQueue(links: Links): string {
	const where =
		links.issues === null
			? ''
			: ` <a class="ext" href="${escape(links.issues)}" ${EXTERNAL}>Open the Tracker</a>.`;
	return `<p class="empty">empty${hint(`Assign a Feature to yourself and give it the Go (<code>${escape(links.signals.go)}</code>).${where}`)}</p>`;
}

// What a waiting Feature needs from the person: which kind of help, and the page to give it on
interface Unblock {
	readonly kind: 'info' | 'person';
	readonly target: string;
	readonly href: string | null;
}

function unblock(card: WaitingCard, links: Links): Unblock | null {
	const first = card.waitingTickets[0];
	const why = first?.why ?? card.why;
	const kind = why === NEEDS_INFO ? 'info' : why === NEEDS_A_PERSON ? 'person' : null;
	if (kind === null) return null;
	const target = first?.id ?? card.id;
	return { kind, target, href: links.issue(target) };
}

const onTracker = (links: Links) => links.tracker ?? 'the Tracker';

function actionLink(u: Unblock | null, links: Links): string {
	if (u?.href == null) return '';
	const verb = u.kind === 'info' ? 'Answer' : 'Open';
	return `<a class="act ext" href="${escape(u.href)}" ${EXTERNAL} aria-label="${verb} ${escape(idText(u.target))} on ${onTracker(links)}">${verb}</a>`;
}

// The label of a waiting Feature: a button that opens the steps to unblock it, when the page knows them
function whyHtml(card: WaitingCard, u: Unblock | null): string {
	const egg = '<i class="egg need"></i>';
	if (u === null) return `<p class="label">${egg}${escape(card.why)}</p>`;
	const id = escape(card.id);
	return `<p class="label"><button type="button" class="why" data-help="${id}" aria-expanded="false" aria-controls="help-${id}">${egg}${escape(card.why)}<span>what to do</span></button></p>`;
}

// The steps that put a stopped Feature back in the Queue, in the repo's own Signal names
function helpHtml(card: WaitingCard, u: Unblock | null, links: Links): string {
	if (u === null) return '';
	const s = links.signals;
	const id = escape(idText(u.target));
	const where =
		u.href === null
			? id
			: `<a class="ext" href="${escape(u.href)}" ${EXTERNAL}>${id} on ${onTracker(links)}</a>`;
	const code = (name: string) => `<code>${escape(name)}</code>`;
	const steps = [
		`Open ${where} and read Nightjar's last comment.`,
		u.kind === 'info'
			? 'Answer in a comment. Only Trusted comments reach the agent.'
			: 'Do what the comment asks, then say so in a comment.',
		`Take ${code(u.kind === 'info' ? s.needsInfo : s.human)} off, put ${code(s.ready)} back on, and give the Go (${code(s.go)}) again.`
	];
	const lead =
		u.kind === 'info'
			? 'Nightjar could not go on without an answer, so it stopped and asked.'
			: 'Nightjar reached something only a person can do, so it stopped.';
	return `<div class="help" id="help-${escape(card.id)}" hidden><p>${lead}</p><ol>${steps.map((x) => `<li>${x}</li>`).join('')}</ol><p>The next run continues on the same branch and pull request.</p></div>`;
}

const LEGEND =
	'<p class="legend"><span><i class="egg built"></i>built</span><span><i class="egg building"></i>building</span><span><i class="egg need"></i>needs a person</span><span><i class="slot"></i>waiting</span></p>';

function board(view: FactoryView, links: Links): string {
	const all = features(view);
	const on = running(view);
	const none = (text: string) => `<p class="empty">${text}</p>`;
	const queued = !on
		? OFF
		: all.queue === undefined
			? none('not read yet')
			: all.queue.length === 0
				? emptyQueue(links)
				: all.queue.map((q) => queuedCard(q, links)).join('');
	const building =
		all.building === null ? none('nothing is being built') : buildingCard(all.building, links);
	let waiting: string;
	if (!on) waiting = OFF;
	else if (all.waiting === undefined) waiting = none('not read yet');
	else {
		const note = all.trackerCannotList ? none('not available from this Tracker') : '';
		const cards = all.waiting
			.map((c) => {
				const u = unblock(c, links);
				return nest(
					'waiting',
					c,
					links,
					progressHtml(c.progress),
					whyHtml(c, u),
					actionLink(u, links),
					waitingTicketsHtml(c, links) + helpHtml(c, u, links)
				);
			})
			.join('');
		waiting = note + (cards === '' ? (all.trackerCannotList ? '' : none('nothing')) : cards);
	}
	const completed =
		all.completed.length === 0
			? none('nothing has finished yet')
			: all.completed.map((c) => completedCard(c, links)).join('');
	const side = all.building === null ? '' : detail(all.building, view, links);
	return (
		`<div class="board">${LEGEND}<div class="cols${side === '' ? '' : ' has-detail'}"><div class="left">` +
		'<div class="head" aria-hidden="true"><span>Feature</span><span>Tickets</span><span>State</span><span>Time and cost</span></div>' +
		group('waiting', 'Waiting on you', on ? (all.waiting?.length ?? null) : null, waiting) +
		group('building', 'Building', on ? (all.building === null ? 0 : 1) : null, building) +
		group('queue', 'Queue', on ? (all.queue?.length ?? null) : null, queued) +
		group('completed', 'Completed', all.completed.length, completed) +
		`</div>${side}</div></div>`
	);
}

const STATES = [
	['queue', 'Queue'],
	['building', 'Building'],
	['waiting', 'Waiting on you'],
	['completed', 'Completed']
] as const;

const COLUMNS = [
	['id', 'Id'],
	['title', 'Title'],
	['state', 'State'],
	['time', 'Time'],
	['cost', 'Cost'],
	['outcome', 'Outcome'],
	['progress', 'Progress']
] as const;

// One row per Feature, in state then Queue order; the page script sorts and filters them in the browser.
function table(view: FactoryView, links: Links): string {
	const all = features(view);
	interface Row {
		readonly card: FeatureCard;
		readonly state: (typeof STATES)[number][0];
		readonly time: number | null;
		readonly timeText: string;
		readonly cost: number | null;
		readonly outcome: string;
		readonly outcomeText: string;
		readonly progress: Progress | null;
	}
	const rows: Row[] = [];
	for (const card of all.queue ?? [])
		rows.push({
			card,
			state: 'queue',
			time: card.estimateMs,
			timeText: estimateHtml(card.estimateMs),
			cost: null,
			outcome: '',
			outcomeText: '',
			progress: card.progress
		});
	if (all.building !== null) {
		// the elapsed time is counted by the browser, so the row stays the same between events
		rows.push({
			card: all.building,
			state: 'building',
			time: null,
			timeText: `<time data-since="${escape(featureStart(all.building.doing))}"></time>`,
			cost: view.featureCostUsd,
			outcome: '',
			outcomeText: '',
			progress: all.building.progress
		});
	}
	for (const card of all.waiting ?? [])
		rows.push({
			card,
			state: 'waiting',
			time: null,
			timeText: '',
			cost: null,
			outcome: card.why,
			outcomeText: `${escape(card.why)} ${actionLink(unblock(card, links), links)}`,
			progress: card.progress
		});
	for (const card of all.completed) {
		const { event, costUsd } = card.done;
		const took = tookMs(event);
		rows.push({
			card,
			state: 'completed',
			time: took,
			timeText: took === null ? '' : `<time class="took">${elapsed(took)}</time>`,
			cost: costUsd,
			outcome: event.kind === 'pull' ? event.url : `failed: ${event.why}`,
			outcomeText: outcomeHtml(event),
			progress: card.progress
		});
	}
	const label = (state: string) => STATES.find(([s]) => s === state)?.[1] ?? state;
	const chips = STATES.map(
		([s, name]) => `<button type="button" data-chip="${s}">${name}</button>`
	).join('');
	const head = COLUMNS.map(
		([k, name]) => `<th><button type="button" data-sort="${k}">${name}</button></th>`
	).join('');
	const body = rows
		.map(
			(r, i) =>
				`<tr data-state="${r.state}"${r.outcome.startsWith('failed: ') ? ' data-failed="true"' : ''} data-order="${String(i)}" data-rank="${String(STATES.findIndex(([s]) => s === r.state))}" data-id="${escape(r.card.id)}" data-title="${escape(r.card.title ?? '')}" data-time="${r.time === null ? '' : String(r.time)}"${r.state === 'building' ? ` data-since="${escape(featureStart((r.card as BuildingCard).doing))}"` : ''} data-cost="${r.cost === null ? '' : String(r.cost)}" data-outcome="${escape(r.outcome)}" data-progress="${r.progress === null ? '' : String(r.progress.total === 0 ? 0 : r.progress.built / r.progress.total)}">` +
				`<td>${r.card.id === '' ? '' : idHtml(r.card.id, links)}</td><td>${escape(r.card.title ?? '')}</td><td>${r.outcome.startsWith('failed: ') ? 'Failed' : label(r.state)}</td><td>${r.timeText}</td><td>${r.cost === null ? '' : dollars(r.cost)}</td><td>${r.outcomeText}</td><td class="progress">${progressHtml(r.progress, r.state === 'building' ? (r.card as BuildingCard).doing.tickets : undefined)}</td></tr>`
		)
		.join('');
	const note = !running(view)
		? OFF
		: all.trackerCannotList
			? '<p class="empty">Waiting on you is not available from this Tracker</p>'
			: '';
	return `<div class="table"><div class="chips">${chips}</div>${note}<div class="scroll" tabindex="0" role="region" aria-label="Feature table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${rows.length === 0 ? '<p class="empty">no Features</p>' : ''}</div>`;
}

// Splits what stays in view (the run's state and numbers) from the content that scrolls beneath it.
const MAIN = '<!--main-->';

// The panels, which the page replaces whole each time an event brings new ones.
export function renderPanels(root: string, view: FactoryView, links: Links = NO_LINKS): string {
	return [
		header(lastRepo(ledgerPath(root)) ?? basename(root), view),
		cards(view),
		MAIN,
		board(view, links),
		table(view, links),
		`<div class="overview">${[current(view, links), queue(view, links), waiting(view, links), completed(view, links)].join('\n')}</div>`
	].join('\n');
}

// Links to the Tracker and the Code host, always at hand in the bar
function elsewhere(links: Links): string {
	const link = (href: string | null, text: string, title: string) =>
		href === null
			? ''
			: `<a class="act ext" href="${escape(href)}" ${EXTERNAL} title="${escape(title)}">${text}</a>`;
	const found =
		link(links.issues, 'Tracker', `Open the Features and Tickets on ${onTracker(links)}`) +
		link(links.pulls, 'Pull requests', 'Open the pull requests on the Code host');
	return found === '' ? '' : `<nav class="elsewhere" aria-label="Open elsewhere">${found}</nav>`;
}

const PAGE = (panels: string, links: Links) => {
	const [top = '', main = ''] = panels.split(MAIN);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nightjar</title>
<style>${STYLE}.banner { background-image: url(${BANNER}); }</style>
</head>
<body>
<a class="skip" href="#panels">Skip to Features</a>
<p id="live" class="sr" role="status"></p>
<div class="bar"><p class="mark">nightjar</p><nav id="views" aria-label="View"><button type="button" data-view="board">Board</button><button type="button" data-view="table">Table</button><button type="button" data-view="overview">Overview</button></nav>${elsewhere(links)}</div>
<div id="top">${top}</div>
<div id="scroll" role="region" aria-label="Features" tabindex="0"><div class="banner" aria-hidden="true"></div><main id="panels" data-view="board" tabindex="-1">${main}</main></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
};

// The browser replaces the panels with each event and counts the clocks itself, so the server pushes only on a change.
const SCRIPT = `
const panels = document.getElementById('panels');
const live = document.getElementById('live');
// below the reflow threshold the whole page scrolls, so the region has nothing to scroll and leaves the tab order
const scroller = document.getElementById('scroll');
const flow = matchMedia('(max-height: 480px), (max-width: 400px)');
const place = () => { scroller.tabIndex = flow.matches ? -1 : 0; };
place();
flow.addEventListener('change', place);
const MAIN = '<!' + '--main-->';
const two = ${String(two)};
const elapsed = ${String(elapsed)};
const countdown = ${String(countdown)};
const VIEWS = ['board', 'table', 'overview'];
// the Table's sort and state filter, kept in local storage and applied again after each event
let tableState = { sort: null, dir: 1, states: [] };
try {
	const kept = JSON.parse(localStorage.getItem('nightjar-table'));
	if (kept && Array.isArray(kept.states)) tableState = { sort: kept.sort ?? null, dir: kept.dir === -1 ? -1 : 1, states: kept.states };
} catch {}
function saveTable() {
	try { localStorage.setItem('nightjar-table', JSON.stringify(tableState)); } catch {}
}
function rowKey(row, key, now) {
	const d = row.dataset;
	if (key === 'time') {
		if (d.since) return now - Date.parse(d.since);
		return d.time === '' || d.time === undefined ? null : Number(d.time);
	}
	if (key === 'cost') return d.cost === '' || d.cost === undefined ? null : Number(d.cost);
	if (key === 'progress') return d.progress === '' || d.progress === undefined ? null : Number(d.progress);
	return d[key] ?? '';
}
// default: state, then Queue order; a header sorts by its column, rows without a value last
function compareRows(a, b, sort, dir, now) {
	const by = (x, y) => {
		if (x === y) return 0;
		if (x === null) return 1;
		if (y === null) return -1;
		return typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
	};
	if (sort !== null) {
		const c = by(rowKey(a, sort, now), rowKey(b, sort, now));
		if (c !== 0) return c * dir;
	}
	return Number(a.dataset.rank) - Number(b.dataset.rank) || Number(a.dataset.order) - Number(b.dataset.order);
}
// the page's own markup carries these; a stand-in element without them is left alone
const attr = (el, name, value) => el && el.setAttribute && el.setAttribute(name, value);
function applyTable() {
	const now = Date.now();
	const rows = Array.from(document.querySelectorAll('tr[data-state]'));
	const parent = rows[0] && rows[0].parentNode;
	rows.sort((a, b) => compareRows(a, b, tableState.sort, tableState.dir, now));
	for (const row of rows) {
		row.hidden = tableState.states.length > 0 && !tableState.states.includes(row.dataset.state);
		if (parent) parent.appendChild(row);
	}
	for (const b of document.querySelectorAll('button[data-sort]')) {
		b.dataset.on = String(b.dataset.sort === tableState.sort);
		b.dataset.dir = b.dataset.sort === tableState.sort ? (tableState.dir === 1 ? 'asc' : 'desc') : '';
		attr(b.parentNode, 'aria-sort', b.dataset.dir === 'asc' ? 'ascending' : b.dataset.dir === 'desc' ? 'descending' : 'none');
	}
	for (const b of document.querySelectorAll('button[data-chip]')) {
		b.dataset.on = String(tableState.states.includes(b.dataset.chip));
		attr(b, 'aria-pressed', b.dataset.on);
	}
}
// the "what to do" panels the person opened, kept across each swap of the panels
const helpOpen = new Set();
function applyHelp() {
	for (const b of document.querySelectorAll('button[data-help]')) {
		if (!b.dataset || !b.dataset.help) continue;
		const open = helpOpen.has(b.dataset.help);
		attr(b, 'aria-expanded', String(open));
		const panel = document.getElementById('help-' + b.dataset.help);
		if (panel) panel.hidden = !open;
	}
}
function copied(button) {
	const was = button.textContent;
	button.textContent = 'copied';
	setTimeout(() => { button.textContent = was; }, 1500);
}
panels.onclick = (e) => {
	const t = e.target && e.target.closest ? e.target : null;
	const sorter = t && t.closest('[data-sort]');
	const chip = t && t.closest('[data-chip]');
	const help = t && t.closest('[data-help]');
	const copy = t && t.closest('[data-copy]');
	if (help) {
		const id = help.dataset.help;
		if (helpOpen.has(id)) helpOpen.delete(id); else helpOpen.add(id);
		applyHelp();
		return;
	}
	if (copy) {
		try { navigator.clipboard.writeText(copy.dataset.copy).then(() => copied(copy)); } catch {}
		return;
	}
	if (sorter) {
		const key = sorter.dataset.sort;
		tableState = { ...tableState, sort: key, dir: tableState.sort === key ? -tableState.dir : 1 };
	} else if (chip) {
		const s = chip.dataset.chip;
		tableState = { ...tableState, states: tableState.states.includes(s) ? tableState.states.filter((x) => x !== s) : [...tableState.states, s] };
	} else return;
	saveTable();
	applyTable();
};
// the choice lives on the panels element and in local storage, so a refresh of its content keeps it
function show(view) {
	panels.dataset.view = view;
	for (const b of document.querySelectorAll('button[data-view]')) {
		b.dataset.on = String(b.dataset.view === view);
		attr(b, 'aria-pressed', b.dataset.on);
	}
}
let saved = null;
try { saved = localStorage.getItem('nightjar-view'); } catch {}
show(VIEWS.includes(saved) ? saved : 'board');
for (const b of document.querySelectorAll('button[data-view]')) {
	b.onclick = () => {
		show(b.dataset.view);
		try { localStorage.setItem('nightjar-view', b.dataset.view); } catch {}
	};
}
// the status region speaks only when the count of Features waiting on a person, or failed, rises
// inner scrollers a swap would reset, matched by position
const SCROLLERS = ['.detail', '.scroll', 'pre'];
let seen = null;
function announce() {
	const waiting = document.querySelectorAll('tr[data-state="waiting"]').length;
	const failed = document.querySelectorAll('tr[data-failed]').length;
	const said = [];
	if (seen && waiting > seen.waiting) said.push(waiting + ' waiting on a person');
	if (seen && failed > seen.failed) said.push(failed + ' failed');
	if (said.length) {
		// clear first so an identical message is read again
		live.textContent = '';
		requestAnimationFrame(() => { live.textContent = said.join(', '); });
	}
	seen = { waiting, failed };
}
function tick() {
	const now = Date.now();
	for (const t of document.querySelectorAll('time[data-since]')) t.textContent = elapsed(now - Date.parse(t.dataset.since));
	for (const t of document.querySelectorAll('time[data-until]')) t.textContent = countdown(Date.parse(t.dataset.until) - now);
}
new EventSource('/events').onmessage = (e) => {
	// a swap drops the focused sort header, chip, help or copy button or link; put focus back on its twin
	const was = document.activeElement;
	const data = (was && was.dataset) || {};
	const key = ['sort', 'chip', 'help', 'copy'].find((k) => data[k]) || (was && was.tagName === 'A' && was.getAttribute('href') ? 'href' : null);
	const value = key && (key === 'href' ? was.getAttribute('href') : data[key]);
	// links can share an href, so remember which of them had focus
	const pool = () => Array.from(document.querySelectorAll(key === 'href' ? 'a[href]' : '[data-' + key + ']')).filter((n) => (key === 'href' ? n.getAttribute('href') : n.dataset[key]) === value);
	const nth = key ? Math.max(0, pool().indexOf(was)) : 0;
	const kept = [];
	for (const sel of SCROLLERS) {
		document.querySelectorAll(sel).forEach((n, i) => kept.push([sel, i, n.scrollTop, n.scrollLeft]));
	}
	const [top, main] = JSON.parse(e.data).split(MAIN);
	document.getElementById('top').innerHTML = top;
	panels.innerHTML = main;
	for (const [sel, i, top, left] of kept) {
		const n = document.querySelectorAll(sel)[i];
		if (n) { n.scrollTop = top; n.scrollLeft = left; }
	}
	if (key) {
		const found = pool();
		const back = found[nth] || found[0];
		if (back) back.focus();
	}
	applyTable();
	announce();
	applyHelp();
	tick();
};
applyTable();
announce();
tick();
setInterval(tick, 1000);
`;

const STYLE = `
:root { color-scheme: dark; --void: #04070b; --panel: #0b131b; --line: #1b3a42; --teal: #22e3d2; --teal2: #14a89c; --amber: #ff9a1f; --slate: #8f98e0; --ok: #3fd17f; --ink: #e6f1f2; --ink2: #9db5b8; --muted: #7f979b; --err: #ff5a5f; --socket-dash: #2f5a63; --socket-border: #3f7078; --bar-overlay: rgba(4, 7, 11, 0.94); --panel-overlay: rgba(8, 13, 19, 0.85); --panel-overlay-strong: rgba(8, 13, 19, 0.92); --teal-wash: color-mix(in srgb, var(--teal) 7%, transparent); --shade-soft: rgba(0, 0, 0, 0.3); --shade-mid: rgba(0, 0, 0, 0.35); --shade-deep: rgba(0, 0, 0, 0.45); --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
* { box-sizing: border-box; }
body { background-color: var(--void); background-size: 32px 32px; background-image: linear-gradient(color-mix(in srgb, var(--teal) 3.5%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--teal) 3.5%, transparent) 1px, transparent 1px); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; --gut: max(32px, calc((100% - 1380px) / 2 + 32px)); }
::selection { background: var(--teal); color: var(--void); }
a { color: var(--teal); text-underline-offset: 3px; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
time, .clock, td, .meta, .label, .tally, .head, .sub, .meters, .steps small, pre { font-variant-numeric: tabular-nums; }
.banner { background: var(--void) center 40% / cover no-repeat; height: 150px; position: relative; }
.banner::after { background: linear-gradient(180deg, transparent 60%, var(--void)); content: ""; inset: 0; position: absolute; }
.bar { align-items: center; background: var(--void); border-bottom: 1px solid var(--line); display: flex; flex: none; gap: 4px; padding: 10px var(--gut); }
#top { background: var(--bar-overlay); border-bottom: 1px solid var(--line); flex: none; padding: 0 var(--gut); }
#scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-color: var(--teal2) var(--void); }
#scroll:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
.elsewhere { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.mark { color: var(--teal); font: 700 0.85rem var(--mono); letter-spacing: 0.2em; margin: 0 22px 0 0; text-transform: uppercase; }
#views { display: flex; gap: 4px; }
#views button { background: none; min-height: 24px; border: 1px solid transparent; color: var(--ink2); cursor: pointer; font: inherit; font-size: 0.85rem; padding: 5px 16px; }
#views button:hover { color: var(--ink); }
#views button[data-on="true"] { background: var(--teal-wash); border-color: var(--teal2); color: var(--teal); }
#panels { margin: 0 auto; max-width: 1380px; min-width: 0; padding: 16px 32px 56px; }
h1, h2 { font-size: 1em; margin: 0; }
header { align-items: baseline; display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 12px 0 2px; }
h1 { font: 700 1.6rem var(--mono); }
header span { color: var(--muted); font-family: var(--mono); font-size: 0.85rem; }
header .state { color: var(--teal); font-weight: 600; }
#cards { color: var(--ink2); display: flex; flex-wrap: wrap; font: 0.85rem var(--mono); gap: 4px 26px; margin: 0; padding: 0 0 10px; }
.stat b { color: var(--ink); }
.empty, small, .meta { color: var(--muted); }
.empty { margin: 10px 0; }
ul, ol { list-style: none; margin: 4px 0; padding: 0; }
pre { background: var(--shade-deep); border: 1px solid var(--line); color: var(--ink2); font: 0.75rem/1.7 var(--mono); margin: 8px 0 0; max-height: 14rem; overflow: auto; padding: 10px 12px; white-space: pre-wrap; }
.overview { font-family: system-ui, sans-serif; }
#panels[data-view="board"] :is(.overview, .table), #panels[data-view="table"] :is(.overview, .board), #panels[data-view="overview"] :is(.board, .table) { display: none; }
.egg { background: radial-gradient(circle at 28% 26%, var(--shade-mid) 0 1.4px, transparent 2.4px), radial-gradient(circle at 66% 58%, var(--shade-soft) 0 1.8px, transparent 2.8px), var(--teal2); border-radius: 50% 50% 50% 50% / 62% 62% 38% 38%; box-shadow: inset -3px -3px 0 var(--shade-soft); display: inline-block; flex: none; height: 1.2rem; position: relative; width: 0.95rem; }
.egg.building { background: var(--teal); outline: 2px solid var(--teal); outline-offset: 3px; animation: incubate 2.4s ease-in-out infinite; }
.egg.need { background: var(--amber); box-shadow: inset -3px -3px 0 var(--shade-soft); margin: 0 0.65rem; }
.egg.need::before, .egg.need::after { background: var(--amber); content: ""; height: 3px; position: absolute; top: 0.45rem; width: 0.5rem; }
.egg.need::before { left: -0.65rem; transform: rotate(-20deg); }
.egg.need::after { right: -0.65rem; transform: rotate(20deg); }
.egg.waiting { background: none; border: 2px dashed var(--socket-dash); box-shadow: none; }
@keyframes incubate { 50% { outline-color: color-mix(in srgb, var(--teal) 25%, transparent); } }
.slot { align-items: center; background: var(--shade-mid); border: 1px solid var(--socket-border); border-radius: 50%; display: inline-grid; height: 1.75rem; place-items: center; width: 1.75rem; }
.slot > .egg.waiting { display: none; }
.eggs { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }
.eggs small { align-self: center; }
.legend { color: var(--muted); display: flex; flex-wrap: wrap; font: 0.85rem var(--mono); gap: 6px 22px; margin: 0 0 14px; }
.legend span { align-items: center; display: inline-flex; gap: 8px; }
.legend .egg { height: 1rem; width: 0.85rem; }
.legend .egg.need { margin: 0 0.5rem; }
.legend .egg.need::before, .legend .egg.need::after { top: 0.35rem; width: 0.4rem; }
.legend .egg.need::before { left: -0.5rem; }
.legend .egg.need::after { right: -0.5rem; }
.cols { display: block; }
.cols.has-detail { align-items: start; display: grid; gap: 20px; grid-template-columns: minmax(0, 1fr) 340px; }
.left { min-width: 0; }
.head { background: var(--void); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; color: var(--muted); display: grid; font-size: 0.75rem; gap: 6px 20px; grid-template-columns: minmax(0, 1fr) 13rem 10.5rem 6.5rem; letter-spacing: 0.18em; margin: 0 0 14px 88px; padding: 6px 18px; text-transform: uppercase; }
.head span:last-child { text-align: right; white-space: nowrap; }
.mat { --h: var(--teal); background: linear-gradient(90deg, color-mix(in srgb, var(--h) 12%, transparent), transparent 45%), var(--panel-overlay); border: 1px solid var(--line); display: grid; grid-template-columns: 88px minmax(0, 1fr); margin-bottom: 16px; position: relative; }
.mat::before, .mat::after { border: 2px solid var(--h); content: ""; height: 16px; pointer-events: none; position: absolute; right: -1px; width: 16px; }
.mat::before { border-bottom: 0; border-left: 0; top: -1px; }
.mat::after { border-left: 0; border-top: 0; bottom: -1px; }
.mat[data-state="waiting"] { --h: var(--amber); }
.mat[data-state="queue"] { --h: var(--slate); }
.mat[data-state="completed"] { --h: var(--ok); }
.tab { align-items: center; border-right: 2px solid var(--h); color: var(--h); display: flex; flex-direction: column; gap: 10px; justify-content: space-between; padding: 14px 6px; }
.tab h2 { font: 600 0.75rem var(--mono); letter-spacing: 0.14em; text-transform: uppercase; transform: rotate(180deg); writing-mode: vertical-rl; }
.tally { align-items: center; background: var(--h); clip-path: polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%); color: var(--void); display: grid; font: 700 1rem var(--mono); font-style: normal; height: 2.3rem; justify-content: center; width: 2.3rem; }
.lines { padding: 4px 18px; }
.entry { align-items: center; border-top: 1px dashed var(--line); display: grid; gap: 6px 20px; grid-template-columns: minmax(0, 1fr) 13rem 10.5rem 6.5rem; overflow-wrap: anywhere; padding: 14px 0; }
.lines > .entry:first-child { border-top: 0; }
.lines > .empty { padding: 10px 0; }
.entry p { margin: 0; }
.who { font-size: 1.05rem; font-weight: 600; }
.who b { color: var(--ink2); font: 500 0.85rem var(--mono); margin-right: 10px; }
.eggcell .meta { font: 0.75rem var(--mono); margin-top: 6px; }
.now .label { align-items: center; color: var(--ink2); display: flex; font: 700 0.75rem var(--mono); letter-spacing: 0.08em; text-transform: uppercase; }
.now .label .egg { height: 1rem; margin: 0 0.85rem 0 0.6rem; width: 0.85rem; }
.now .label .egg.need::before, .now .label .egg.need::after { top: 0.35rem; width: 0.4rem; }
.now .label .egg.need::before { left: -0.5rem; }
.now .label .egg.need::after { right: -0.5rem; }
.now p:not(.label) { color: var(--ink2); font-size: 0.85rem; }
.clock { color: var(--muted); font: 0.85rem var(--mono); text-align: right; }
.entry > ul { grid-column: 1 / -1; }
.entry.waiting .now .label { color: var(--amber); }
.entry.building .now .label { color: var(--teal); }
.entry.pulled .now .label { color: var(--ok); }
.entry.failed .now .label, .entry.failed .now p { color: var(--err); }
.tickets li { font: 0.85rem var(--mono); padding: 2px 0 2px 4px; }
.tickets li.waiting { color: var(--amber); }
.detail { background: linear-gradient(180deg, var(--teal-wash), transparent 40%), var(--panel-overlay-strong); border: 1px solid var(--teal2); font-family: var(--mono); padding: 18px; position: sticky; top: 16px; }
.detail::before, .detail::after { border: 2px solid var(--teal); content: ""; height: 16px; pointer-events: none; position: absolute; width: 16px; }
.detail::before { border-bottom: 0; border-right: 0; left: -1px; top: -1px; }
.detail::after { border-left: 0; border-top: 0; bottom: -1px; right: -1px; }
.dk { align-items: center; color: var(--teal); display: flex; font-size: 0.75rem; gap: 8px; letter-spacing: 0.18em; margin: 0; text-transform: uppercase; }
.dk i { animation: blip 2s ease-out infinite; background: var(--teal); border-radius: 50%; height: 8px; width: 8px; }
@keyframes blip { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--teal) 60%, transparent); } 100% { box-shadow: 0 0 0 9px transparent; } }
.detail h3 { font: 700 1.2rem system-ui, sans-serif; margin: 8px 0 2px; overflow-wrap: anywhere; }
.detail h3 b { color: var(--ink2); font: 500 0.85rem var(--mono); margin-right: 8px; }
.sub { color: var(--muted); font-size: 0.75rem; margin: 0; }
.steps { margin: 16px 0; position: relative; }
.steps::before { background: var(--line); bottom: 8px; content: ""; left: 8px; position: absolute; top: 8px; width: 1px; }
.steps li { color: var(--ink2); font-size: 0.85rem; padding: 4px 0 4px 30px; position: relative; }
.steps li::before { background: var(--void); border: 1.5px solid var(--muted); clip-path: polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%); content: ""; height: 13px; left: 2px; position: absolute; top: 8px; width: 13px; }
.steps li.built { color: var(--muted); }
.steps li.built::before { background: var(--teal2); border-color: var(--teal2); }
.steps li.building { color: var(--ink); font-weight: 700; }
.steps li.building::before { background: var(--teal); border-color: var(--teal); }
.steps li.waiting { color: var(--amber); }
.steps li.waiting::before { border-color: var(--amber); }
.meters { display: grid; gap: 8px; grid-template-columns: 1fr 1fr; margin-bottom: 14px; }
.meters div { background: var(--shade-soft); border: 1px solid var(--line); padding: 6px 10px; }
.meters small { display: block; font-size: 0.75rem; letter-spacing: 0.14em; text-transform: uppercase; }
.meters b { font-size: 1rem; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 10px; }
.chips button { background: none; min-height: 24px; border: 1px solid var(--teal2); border-radius: 999px; color: var(--teal); cursor: pointer; font: inherit; font-size: 0.85rem; padding: 3px 14px; }
.chips button[data-on="true"] { background: var(--teal); border-color: var(--teal); color: var(--void); }
.scroll { overflow-x: auto; }
.sr, .skip:not(:focus) { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
.skip { background: var(--void); color: var(--teal); left: 8px; padding: 8px 12px; top: 8px; z-index: 4; }
td.progress .eggs { display: inline-flex; vertical-align: middle; }
td.progress p { display: inline; margin: 0 0 0 14px; }
.scroll:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
tr[data-state] td:first-child { border-left: 3px solid var(--teal); }
tr[data-state="waiting"] td:first-child { border-left-color: var(--amber); }
tr[data-state="queue"] td:first-child { border-left-color: var(--slate); }
tr[data-state="completed"] td:first-child { border-left-color: var(--ok); }
tr[data-failed] td:first-child { border-left-color: var(--err); }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; }
th button { align-items: center; background: none; border: 0; display: inline-flex; min-height: 24px; color: var(--muted); cursor: pointer; font: 600 0.75rem var(--mono); letter-spacing: 0.16em; padding: 0; text-transform: uppercase; }
th button[data-on="true"] { color: var(--teal); }
th button[data-dir]::after { border: solid currentColor; border-width: 0 2px 2px 0; content: ""; display: inline-block; height: 0.4em; margin-left: 0.6em; transform: rotate(45deg) translateY(-0.2em); width: 0.4em; }
th button[data-dir="asc"]::after { transform: rotate(-135deg) translate(-0.1em, -0.1em); }
tr[hidden] { display: none; }
td.progress .eggs { margin-bottom: 4px; }
.overview section { border-top: 1px solid var(--line); margin-top: 24px; padding-top: 12px; }
.overview h2 { color: var(--teal2); font: 600 0.75rem var(--mono); letter-spacing: 0.2em; text-transform: uppercase; }
.overview li { padding: 3px 0; }
a.ext { color: inherit; text-decoration-color: var(--muted); text-decoration-style: dotted; text-underline-offset: 3px; }
a.ext:hover { color: var(--teal); text-decoration-style: solid; }
a.act { align-items: center; border: 1px solid var(--teal2); color: var(--teal); display: inline-flex; font: 0.75rem var(--mono); gap: 6px; min-height: 24px; padding: 2px 9px; text-decoration: none; white-space: nowrap; }
a.act:hover { background: color-mix(in srgb, var(--teal) 12%, transparent); color: var(--teal); }
a.act::after { background: currentColor; content: ""; height: 0.8em; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.8'%3E%3Cpath d='M6 3H3v10h10v-3M9 2h5v5M14 2 7 9'/%3E%3C/svg%3E") center / contain no-repeat; width: 0.8em; }
.entry.waiting a.act { border-color: var(--amber); color: var(--amber); }
.entry.waiting a.act:hover { background: color-mix(in srgb, var(--amber) 12%, transparent); }
.clock a.act { margin-left: auto; }
button.why { align-items: center; flex-wrap: wrap; background: none; border: 0; color: inherit; cursor: pointer; display: inline-flex; font: inherit; letter-spacing: inherit; padding: 2px 0; position: relative; text-align: left; text-transform: inherit; }
button.why span { color: var(--ink2); flex-basis: 100%; padding: 2px 0 0 2.4rem; white-space: nowrap; font-weight: 400; letter-spacing: 0; text-decoration: underline dotted; text-underline-offset: 3px; text-transform: none; }
button.why[aria-expanded="true"] span { color: var(--amber); }
.entry > .help { background: color-mix(in srgb, var(--amber) 6%, transparent); border: 1px dashed var(--amber); font-size: 0.85rem; grid-column: 1 / -1; max-width: 64ch; padding: 10px 16px; }
.help p { margin: 4px 0; }
.help p:last-child { color: var(--ink2); }
.help ol { list-style: decimal; margin: 6px 0; padding-left: 1.3rem; }
.help li { padding: 2px 0; }
code { background: color-mix(in srgb, var(--teal) 10%, transparent); color: var(--teal); font: 0.85em var(--mono); padding: 1px 5px; }
.hint { color: var(--ink2); display: block; font-size: 0.85rem; margin-top: 2px; }
button.copy { background: none; border: 1px solid var(--teal2); color: var(--teal); cursor: pointer; font: 0.75rem var(--mono); margin-left: 4px; min-height: 24px; padding: 1px 8px; }
button.copy:hover { background: color-mix(in srgb, var(--teal) 12%, transparent); }
@media (prefers-reduced-motion: reduce) { .egg.building, .dk i { animation: none; } }
@media (min-width: 1261px) and (max-width: 1400px) {
	.cols.has-detail .entry { grid-template-columns: 1fr; }
	.cols.has-detail .head { display: none; }
}
@media (max-width: 1260px) {
	.cols.has-detail { grid-template-columns: 1fr; }
	.detail { order: -1; position: static; }
}
@media (pointer: coarse) {
	th button, #views button, .chips button, button.copy, a.act { min-height: 44px; }
	#views button, .chips button { padding-inline: 20px; }
}
@media (max-height: 480px), (max-width: 400px) {
	body { height: auto; overflow: visible; }
	#scroll { overflow: visible; }
}
@media (max-width: 900px) {
	.entry { grid-template-columns: 1fr; }
	.head { display: none; }
	.clock { text-align: left; }
}
@media (max-width: 760px) {
	body { --gut: 12px; }
	h1 { font-size: 1.2rem; }
	#cards { font-size: 0.75rem; gap: 2px 14px; }
	.mark { display: none; }
	.banner { background-position: 25% 40%; height: 100px; }
	.bar { flex-wrap: wrap; }
	#panels { padding: 12px 12px 40px; }
	.mat { grid-template-columns: 40px minmax(0, 1fr); }
	.tab { padding: 10px 4px; }
	.tally { height: 1.9rem; width: 1.9rem; font-size: 0.85rem; }
	.lines { padding: 4px 12px; }
	.scroll table { min-width: 36rem; }
}
`;

// The Host header must name this machine, or a DNS name rebound to 127.0.0.1 could read the page from another site.
const hostOk = (host: string | undefined, port: number) =>
	host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`;

// The origin remote's url, which names the GitHub repo when factory.json does not; null with no remote
function originOf(root: string): string | null {
	try {
		const url = execFileSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
		return url === '' ? null : url;
	} catch {
		return null;
	}
}

export function startUi(o: UiOptions): Promise<Ui> {
	const origin = originOf(o.root);
	const clients = new Set<ServerResponse>();
	const panelsNow = () =>
		renderPanels(
			o.root,
			readFactory(o.root, {
				...(o.alive === undefined ? {} : { alive: o.alive }),
				...(o.now === undefined ? {} : { now: o.now })
			}),
			linksFor(o.root, origin)
		);
	const send = (res: ServerResponse, panels: string) =>
		res.write(`data: ${JSON.stringify(panels)}\n\n`);

	let last = panelsNow();
	// pushes only when what the page shows has changed
	const refresh = () => {
		const panels = panelsNow();
		if (panels === last) return;
		last = panels;
		for (const res of clients) send(res, panels);
	};

	const server = createServer((req, res) => {
		const { port } = server.address() as AddressInfo;
		if (!hostOk(req.headers.host, port)) {
			res.writeHead(403).end();
		} else if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405, { allow: 'GET, HEAD' }).end();
		} else if (req.url === '/events') {
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-store'
			});
			send(res, panelsNow());
			clients.add(res);
			res.on('close', () => clients.delete(res));
		} else if (req.url === '/') {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'content-security-policy':
					"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:"
			});
			res.end(req.method === 'HEAD' ? undefined : PAGE(panelsNow(), linksFor(o.root, origin)));
		} else {
			res.writeHead(404).end();
		}
	});

	// The file change brings the event; the slow look also catches what no file says, a run whose process died.
	let timer: NodeJS.Timeout | undefined;
	const watch = (): FSWatcher | null => {
		try {
			return fsWatch(join(o.root, '.factory'), { recursive: true }, () => {
				clearTimeout(timer);
				timer = setTimeout(refresh, 50);
			});
		} catch {
			// no .factory/ yet: the slow look finds it
			return null;
		}
	};
	let watcher = watch();
	const slow = setInterval(() => {
		watcher ??= watch();
		refresh();
	}, 2000);

	return new Promise((done, fail) => {
		server.once('error', fail);
		server.listen(o.port, HOST, () => {
			const { address, port } = server.address() as AddressInfo;
			done({
				address,
				port,
				close: () =>
					new Promise<void>((closed) => {
						clearInterval(slow);
						clearTimeout(timer);
						watcher?.close();
						server.closeAllConnections();
						server.close(() => closed());
					})
			});
		});
	});
}
