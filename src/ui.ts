// `nightjar ui`: a read-only page about the repo, drawn from .factory/ alone, pushed to the browser as server-sent events.
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { ledgerPath } from './build.js';
import { lastRepo } from './ledger.js';
import { readFactory, type FactoryView } from './status-reader.js';

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

const money = (usd: number) => `$${usd.toFixed(2)}`;
// a numeric id reads as #42; another Tracker's (PROJ-123) as it is
const idText = (id: string) => escape(/^\d+$/.test(id) ? `#${id}` : id);
const clock = (iso: string) =>
	new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function runState(view: FactoryView): string {
	if (view.status === null) return 'off';
	if (view.stopped) return 'stopped';
	switch (view.status.doing.kind) {
		case 'off':
			return 'off';
		case 'idle':
			return 'idle';
		case 'building':
			return 'watching';
		case 'paused':
			return 'paused';
	}
}

// With no run going there is no Queue to show, only history.
const running = (view: FactoryView) => runState(view) !== 'off' && runState(view) !== 'stopped';

function header(repo: string, view: FactoryView): string {
	const doing = view.status?.doing;
	const poll =
		doing?.kind === 'idle' && running(view)
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
			: `${money(status.spentTodayUsd)} of ${money(status.dailyUsd)}`;
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
		body = `<ul>${status.queue.map((q) => `<li>${idText(q.id)} ${escape(q.title)}</li>`).join('')}</ul>`;
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
					`<li class="${t.state}">${idText(t.id)} ${escape(t.title)} <small>${t.state}${t.why === undefined ? '' : `: ${escape(t.why)}`}</small></li>`
			)
			.join('');
		const tail = view.tail.map(escape).join('\n');
		body =
			`<p>${idText(doing.feature)}${doing.title === undefined ? '' : ` ${escape(doing.title)}`} <time data-since="${escape(doing.startedAt)}"></time> ${money(view.featureCostUsd)}</p>` +
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
			.map((i) => `<li>${idText(i.id)} ${escape(i.title)}: ${escape(i.why)}</li>`)
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
			return `<li>${idText(event.feature)}${event.title === undefined ? '' : escape(` ${event.title}`)} ${outcome} ${money(costUsd)}</li>`;
		})
		.reverse()
		.join('');
	return `<section id="completed"><h2>Completed</h2>${rows === '' ? '<p class="empty">nothing has finished yet</p>' : `<ul>${rows}</ul>`}</section>`;
}

// The panels, which the page replaces whole each time an event brings new ones.
export function renderPanels(root: string, view: FactoryView): string {
	return [
		header(lastRepo(ledgerPath(root)) ?? basename(root), view),
		cards(view),
		current(view),
		queue(view),
		waiting(view),
		completed(view)
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
<main id="panels">${panels}</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

// The browser replaces the panels with each event and counts the clocks itself, so the server pushes only on a change.
const SCRIPT = `
const panels = document.getElementById('panels');
const two = (n) => String(n).padStart(2, '0');
function tick() {
	const now = Date.now();
	for (const t of document.querySelectorAll('time[data-since]')) {
		const s = Math.max(0, Math.floor((now - Date.parse(t.dataset.since)) / 1000));
		t.textContent = s >= 3600
			? Math.floor(s / 3600) + 'h ' + two(Math.floor((s % 3600) / 60)) + 'm'
			: Math.floor(s / 60) + 'm ' + two(s % 60) + 's';
	}
	for (const t of document.querySelectorAll('time[data-until]')) {
		const s = Math.max(0, Math.ceil((Date.parse(t.dataset.until) - now) / 1000));
		t.textContent = Math.floor(s / 60) + ':' + two(s % 60);
	}
}
new EventSource('/events').onmessage = (e) => {
	panels.innerHTML = JSON.parse(e.data);
	tick();
};
tick();
setInterval(tick, 1000);
`;

const STYLE = `
:root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; }
@media (prefers-color-scheme: dark) { :root { --muted: #9ca3af; --line: #374151; } }
body { font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0 auto; max-width: 56rem; padding: 0 16px 32px; }
h1, h2 { font-size: 1em; margin: 0; }
h2 { color: var(--muted); font-weight: normal; margin-top: 1.5em; }
header { border-bottom: 1px solid var(--line); padding: 16px 0 8px; }
#cards { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; }
.card span, .empty, small { color: var(--muted); }
ul { list-style: none; margin: 4px 0; padding: 0; }
pre { border: 1px solid var(--line); border-radius: 6px; margin: 8px 0; overflow-x: auto; padding: 8px; white-space: pre-wrap; }
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
