// `nightjar ui`: a read-only page about the repo, drawn from .factory/ alone, pushed to the browser as server-sent events.
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { ledgerPath } from './build.js';
import { lastRepo } from './ledger.js';
import { readFactory, type Completed, type FactoryView } from './status-reader.js';
import type { Doing, Named, Queued, TicketCounts, WaitingItem } from './status-shape.js';
import { featureStart } from './status.js';
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

const idHtml = (id: string) => escape(idText(id));
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
	return `<header><h1>nightjar</h1> <span class="repo">${escape(repo)}</span> <span class="state">${runState(view)}</span>${poll}</header>`;
}

function cards(view: FactoryView): string {
	const status = view.status;
	const spent =
		status === null
			? 'no spend recorded'
			: `${dollars(status.spentTodayUsd)} of ${dollars(status.dailyUsd)}`;
	const waiting = status?.waitingOnYou?.items.length;
	return `<section id="cards"><div class="card"><span>spent today</span> ${spent}</div><div class="card"><span>built today</span> <b>${String(view.builtToday)}</b></div><div class="card"><span>waiting on you</span> <b>${waiting === undefined ? '-' : String(waiting)}</b></div></section>`;
}

function queue(view: FactoryView): string {
	const status = view.status;
	let body: string;
	if (!running(view)) body = '<p class="empty">not known while nightjar is off</p>';
	else if (status?.queue === undefined) body = '<p class="empty">not read yet</p>';
	else if (status.queue.length === 0) body = '<p class="empty">empty</p>';
	else
		body = `<ul>${status.queue.map((q) => `<li>${idHtml(q.id)} ${escape(q.title)}</li>`).join('')}</ul>`;
	const refreshed =
		running(view) && status?.refreshedAt !== undefined
			? ` <small>refreshed ${clock(status.refreshedAt)}</small>`
			: '';
	return `<section id="queue"><h2>Queue${refreshed}</h2>${body}</section>`;
}

function current(view: FactoryView): string {
	const doing = view.status?.doing;
	let body = '<p class="empty">nothing is being built</p>';
	if (doing?.kind === 'building' && running(view)) {
		const tickets = doing.tickets ?? [];
		const at = tickets.findIndex((t) => t.id === doing.ticket);
		const where = at < 0 ? '' : `Ticket ${String(at + 1)} of ${String(tickets.length)}, `;
		const round =
			doing.round === null || doing.rounds === null
				? ''
				: `, round ${String(doing.round)} of ${String(doing.rounds)}`;
		const progress = tickets
			.map(
				(t) =>
					`<li class="${t.state}">${idHtml(t.id)} ${escape(t.title)} <small>${t.state}${t.why === undefined ? '' : `: ${escape(t.why)}`}</small></li>`
			)
			.join('');
		const tail = view.tail.map(escape).join('\n');
		body =
			`<p>${idHtml(doing.feature)}${doing.title === undefined ? '' : ` ${escape(doing.title)}`} <time data-since="${escape(featureStart(doing))}"></time> ${dollars(view.featureCostUsd)}</p>` +
			`<p>${where}${doing.step}${round}</p>` +
			(progress === '' ? '' : `<ul>${progress}</ul>`) +
			(tail === '' ? '' : `<pre>${tail}</pre>`);
	}
	return `<section id="current"><h2>Current build</h2>${body}</section>`;
}

function waiting(view: FactoryView): string {
	const found = view.status?.waitingOnYou;
	let body: string;
	if (!running(view)) body = '<p class="empty">not known while nightjar is off</p>';
	else if (found === undefined) body = '<p class="empty">not read yet</p>';
	else {
		const note = found.trackerCannotList
			? '<p class="empty">not available from this Tracker</p>'
			: found.items.length === 0
				? '<p class="empty">nothing</p>'
				: '';
		const items = found.items
			.map((i) => `<li>${idHtml(i.id)} ${escape(i.title)}: ${escape(i.why)}</li>`)
			.join('');
		body = note + (items === '' ? '' : `<ul>${items}</ul>`);
	}
	return `<section id="waiting"><h2>Waiting on you</h2>${body}</section>`;
}

// a javascript: link in a pull request url would run on click
const safeUrl = (url: string) => /^https?:\/\//.test(url);

function completed(view: FactoryView): string {
	const rows = view.completed
		.map(({ event, costUsd }) => {
			const outcome =
				event.kind === 'pull'
					? safeUrl(event.url)
						? `<a href="${escape(event.url)}">draft pull request</a>`
						: escape(event.url)
					: `failed: ${escape(event.why)}`;
			return `<li>${idHtml(event.feature)}${event.title === undefined ? '' : escape(` ${event.title}`)} ${outcome} ${dollars(costUsd)}</li>`;
		})
		.reverse()
		.join('');
	return `<section id="completed"><h2>Completed</h2>${rows === '' ? '<p class="empty">nothing has finished yet</p>' : `<ul>${rows}</ul>`}</section>`;
}

type Building = Extract<Doing, { kind: 'building' }>;

// A Feature as a view draws it; every view reads this one list.
interface FeatureCard {
	readonly id: string;
	readonly title?: string;
	// the Tickets that wait on a person, with why
	readonly waitingTickets: readonly WaitingItem[];
}
interface QueuedCard extends FeatureCard {
	readonly state: 'queue';
	// null when the count could not be read; undefined when the Tracker cannot count
	readonly ticketCounts: TicketCounts | null | undefined;
}
interface BuildingCard extends FeatureCard {
	readonly state: 'building';
	readonly doing: Building;
}
interface WaitingCard extends FeatureCard {
	readonly state: 'waiting';
	readonly why: string;
}
interface CompletedCard extends FeatureCard {
	readonly state: 'completed';
	readonly done: Completed;
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
	const building: BuildingCard | null =
		doing?.kind === 'building' && on
			? {
					state: 'building',
					id: doing.feature,
					...(doing.title === undefined ? {} : { title: doing.title }),
					waitingTickets: (doing.tickets ?? [])
						.filter((t) => t.state === 'waiting')
						.map((t) => ({ kind: 'ticket', id: t.id, title: t.title, why: t.why ?? '' })),
					doing
				}
			: null;
	const completedCard = (done: Completed): CompletedCard => ({
		state: 'completed',
		id: done.event.feature,
		...(done.event.title === undefined ? {} : { title: done.event.title }),
		waitingTickets: [],
		done
	});
	const completed = view.completed.map(completedCard).reverse();
	const found = on ? status?.waitingOnYou : undefined;
	let waiting: WaitingCard[] | undefined;
	if (found !== undefined) {
		waiting = found.items
			.filter((i) => i.kind === 'feature')
			.map((i) => ({
				state: 'waiting',
				id: i.id,
				title: i.title,
				why: i.why,
				waitingTickets: []
			}));
		// a waiting Ticket belongs to the Feature being built, else to the one that just ended
		const owner = building ?? completed[0];
		const parent: Named | undefined =
			owner === undefined ? undefined : { id: owner.id, title: owner.title ?? '' };
		const tickets = found.items.filter((i) => i.kind === 'ticket');
		if (tickets.length > 0) {
			const at = parent === undefined ? -1 : waiting.findIndex((w) => w.id === parent.id);
			const own = at < 0 ? undefined : waiting[at];
			if (own !== undefined) waiting[at] = { ...own, waitingTickets: tickets };
			else
				waiting.push({
					state: 'waiting',
					id: parent?.id ?? '',
					...(parent === undefined || parent.title === '' ? {} : { title: parent.title }),
					why: tickets.some((t) => t.why.includes('info')) ? 'needs info' : 'needs a person',
					waitingTickets: tickets
				});
		}
	}
	const queued = (q: Queued): QueuedCard => ({
		state: 'queue',
		id: q.id,
		title: q.title,
		waitingTickets: [],
		ticketCounts: q.ticketCounts
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

const feature = (card: FeatureCard) =>
	`<b>${card.id === '' ? '' : idHtml(card.id)}</b> ${card.title === undefined ? '' : escape(card.title)}`;

const waitingTicketsHtml = (card: FeatureCard) =>
	card.waitingTickets.length === 0
		? ''
		: `<ul class="tickets">${card.waitingTickets.map((t) => `<li class="waiting">${idHtml(t.id)} ${escape(t.title)} <small>${escape(t.why)}</small></li>`).join('')}</ul>`;

function buildingCard(card: BuildingCard, view: FactoryView): string {
	const { doing } = card;
	const tickets = doing.tickets ?? [];
	const at = tickets.findIndex((t) => t.id === doing.ticket);
	const where = at < 0 ? '' : `Ticket ${String(at + 1)} of ${String(tickets.length)}, `;
	const round =
		doing.round === null || doing.rounds === null
			? ''
			: `, round ${String(doing.round)} of ${String(doing.rounds)}`;
	const list = tickets
		.map(
			(t) =>
				`<li class="${t.state}">${idHtml(t.id)} ${escape(t.title)} <small>${t.state}${t.why === undefined ? '' : `: ${escape(t.why)}`}</small></li>`
		)
		.join('');
	const tail = view.tail.map(escape).join('\n');
	return (
		`<article class="fcard building">${feature(card)}` +
		`<p class="meta"><time data-since="${escape(featureStart(doing))}"></time> ${dollars(view.featureCostUsd)}</p>` +
		`<p>${where}${doing.step}${round}</p>` +
		(list === '' ? '' : `<ul class="tickets">${list}</ul>`) +
		(tail === '' ? '' : `<pre>${tail}</pre>`) +
		'</article>'
	);
}

// A Feature not yet started: its Ticket count, `0 of N` and a bar; "?" and no bar when the count failed; nothing when the Tracker cannot count.
function queuedCard(card: QueuedCard): string {
	const counts = card.ticketCounts;
	let count = '';
	if (counts === null) count = '<p class="meta count">? Tickets</p>';
	else if (counts !== undefined) {
		const n = String(counts.total);
		count = `<p class="meta count">${n} ${counts.total === 1 ? 'Ticket' : 'Tickets'}</p><div class="bar"><i style="width:0%"></i></div><p class="meta">0 of ${n} built</p>`;
	}
	return `<article class="fcard">${feature(card)}${count}</article>`;
}

function completedCard(card: CompletedCard): string {
	const { event, costUsd } = card.done;
	const outcome =
		event.kind === 'pull'
			? safeUrl(event.url)
				? `<a href="${escape(event.url)}">draft pull request</a>`
				: escape(event.url)
			: `failed: ${escape(event.why)}`;
	// a Feature whose event has no start, or a start that does not read, shows no duration
	const took =
		event.startedAt === undefined ? NaN : Date.parse(event.at) - Date.parse(event.startedAt);
	const duration = Number.isNaN(took) ? '' : `<time class="took">${elapsed(took)}</time> `;
	return `<article class="fcard ${event.kind === 'failed' ? 'failed' : 'pulled'}">${feature(card)}<p>${outcome}</p><p class="meta">${duration}${dollars(costUsd)}</p></article>`;
}

function column(name: string, body: string): string {
	return `<section class="column"><h2>${name}</h2>${body}</section>`;
}

const OFF = '<p class="empty">not known while nightjar is off</p>';

function board(view: FactoryView): string {
	const all = features(view);
	const on = running(view);
	const none = (text: string) => `<p class="empty">${text}</p>`;
	const queued = !on
		? OFF
		: all.queue === undefined
			? none('not read yet')
			: all.queue.length === 0
				? none('empty')
				: all.queue.map(queuedCard).join('');
	const building =
		all.building === null ? none('nothing is being built') : buildingCard(all.building, view);
	let waiting: string;
	if (!on) waiting = OFF;
	else if (all.waiting === undefined) waiting = none('not read yet');
	else {
		const note = all.trackerCannotList ? none('not available from this Tracker') : '';
		const cards = all.waiting
			.map(
				(c) =>
					`<article class="fcard waiting">${feature(c)}<p>${escape(c.why)}</p>${waitingTicketsHtml(c)}</article>`
			)
			.join('');
		waiting = note + (cards === '' ? (all.trackerCannotList ? '' : none('nothing')) : cards);
	}
	const completed =
		all.completed.length === 0
			? none('nothing has finished yet')
			: all.completed.map(completedCard).join('');
	return `<div class="board">${column('Queue', queued)}${column('Building', building)}${column('Waiting on you', waiting)}${column('Completed', completed)}</div>`;
}

// The panels, which the page replaces whole each time an event brings new ones.
export function renderPanels(root: string, view: FactoryView): string {
	return [
		header(lastRepo(ledgerPath(root)) ?? basename(root), view),
		cards(view),
		board(view),
		`<div class="overview">${[current(view), queue(view), waiting(view), completed(view)].join('\n')}</div>`
	].join('\n');
}

const PAGE = (panels: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nightjar</title>
<style>${STYLE}</style>
</head>
<body>
<nav id="views" aria-label="View"><button type="button" data-view="board">Board</button><button type="button" data-view="overview">Overview</button></nav>
<main id="panels" data-view="board">${panels}</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

// The browser replaces the panels with each event and counts the clocks itself, so the server pushes only on a change.
const SCRIPT = `
const panels = document.getElementById('panels');
const two = ${String(two)};
const elapsed = ${String(elapsed)};
const countdown = ${String(countdown)};
const VIEWS = ['board', 'overview'];
// the choice lives on the panels element and in local storage, so a refresh of its content keeps it
function show(view) {
	panels.dataset.view = view;
	for (const b of document.querySelectorAll('button[data-view]')) b.dataset.on = String(b.dataset.view === view);
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
function tick() {
	const now = Date.now();
	for (const t of document.querySelectorAll('time[data-since]')) t.textContent = elapsed(now - Date.parse(t.dataset.since));
	for (const t of document.querySelectorAll('time[data-until]')) t.textContent = countdown(Date.parse(t.dataset.until) - now);
}
new EventSource('/events').onmessage = (e) => {
	panels.innerHTML = JSON.parse(e.data);
	tick();
};
tick();
setInterval(tick, 1000);
`;

const STYLE = `
:root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --surface: #f9fafb; --accent: #2563eb; --bad: #dc2626; --good: #16a34a; }
@media (prefers-color-scheme: dark) { :root { --muted: #9ca3af; --line: #374151; --surface: #1f2937; --accent: #60a5fa; --bad: #f87171; --good: #4ade80; } }
body { font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; margin: 0 auto; max-width: 80rem; padding: 0 20px 32px; }
h1, h2 { font-size: 1em; margin: 0; }
h1 { font-size: 1.25em; display: inline; }
h2 { color: var(--muted); font-weight: 600; margin-top: 1.5em; }
header { border-bottom: 1px solid var(--line); padding: 20px 0 10px; }
header .repo, header .state { color: var(--muted); margin-left: 8px; }
#views { display: flex; gap: 4px; padding-top: 12px; }
#views button { background: none; border: 1px solid var(--line); border-radius: 6px; color: inherit; cursor: pointer; font: inherit; padding: 4px 14px; }
#views button[data-on="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
#cards { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; }
.card span, .empty, small, .meta { color: var(--muted); }
ul { list-style: none; margin: 4px 0; padding: 0; }
pre, time, .overview { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { border: 1px solid var(--line); border-radius: 6px; font-size: 12px; margin: 8px 0; max-height: 14rem; overflow: auto; padding: 8px; white-space: pre-wrap; }
#panels[data-view="board"] .overview, #panels[data-view="overview"] .board { display: none; }
.board { display: grid; gap: 16px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.column { min-width: 0; }
.fcard { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; margin-top: 10px; overflow-wrap: anywhere; padding: 10px 12px; }
.fcard p { margin: 4px 0; }
.bar { background: var(--line); border-radius: 4px; height: 6px; overflow: hidden; }
.bar > i { background: var(--accent); display: block; height: 100%; }
.fcard.building { border-color: var(--accent); }
.fcard.failed { border-color: var(--bad); color: var(--bad); }
.fcard.pulled a { color: var(--good); }
.tickets li.built { color: var(--good); }
.tickets li.building { color: var(--accent); font-weight: 600; }
@media (max-width: 700px) { .board { grid-template-columns: 1fr; } }
`;

// The Host header must name this machine, or a DNS name rebound to 127.0.0.1 could read the page from another site.
const hostOk = (host: string | undefined, port: number) =>
	host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`;

export function startUi(o: UiOptions): Promise<Ui> {
	const clients = new Set<ServerResponse>();
	const panelsNow = () =>
		renderPanels(
			o.root,
			readFactory(o.root, {
				...(o.alive === undefined ? {} : { alive: o.alive }),
				...(o.now === undefined ? {} : { now: o.now })
			})
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
					"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"
			});
			res.end(req.method === 'HEAD' ? undefined : PAGE(panelsNow()));
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
