// The Feature detail panel of `nightjar ui`: a Feature's spec, then its Tickets in Build order with their Signals, blockers and acceptance criteria, read from the Tracker when the panel opens (docs/adr/0009).
import { escapeHtml as escape, markdown } from './markdown.js';
import { why } from './say.js';
import type { Signal } from './signals.js';
import { acceptanceCriteria } from './ticket-contract.js';
import type { ItemId, Ticket } from './tracker.js';
import { EXTERNAL, idHtml, type Links } from './ui-links.js';
import type { FeatureDetail } from './ui-tracker.js';
import { idText } from './view-text.js';

// The panel's address on the page; the id rides in `?id=`.
export const FEATURE_PATH = '/feature';

// An id longer than this is no Tracker's, so the page asks nothing for it.
const ID_MAX = 200;

// What the server answers a request for a panel.
export interface Answer {
	readonly status: number;
	// the panel's markup, which the page sets as the panel's content
	readonly body: string;
}

// The link to the Feature on the Tracker, where the page knows one
function onTracker(id: ItemId, links: Links): string {
	const href = links.issue(id);
	if (href === null) return '';
	const where = links.tracker ?? 'the Tracker';
	return `<p><a class="act ext" href="${escape(href)}" ${EXTERNAL}>Open ${escape(idText(id))} on ${escape(where)}</a></p>`;
}

const title = (id: ItemId, text: string, links: Links) =>
	`<h2 id="feature-title"><b>${idHtml(id, links)}</b> ${escape(text)}</h2>`;

// a Signal in the repo's own name for it
const signalsHtml = (signals: readonly Signal[], links: Links) =>
	signals.length === 0
		? '<p class="meta">no Signals</p>'
		: `<p class="signals">${signals.map((s) => `<code>${escape(links.signals[s])}</code>`).join(' ')}</p>`;

// What blocks a Ticket: each blocker, open or closed, and whether it is a Ticket of another Feature
function blockersHtml(ticket: Ticket, own: ReadonlySet<ItemId>, links: Links): string {
	if (ticket.blockedBy.length === 0) return '';
	const each = ticket.blockedBy.map((b) => {
		const notes = [b.open ? 'open' : 'closed', ...(own.has(b.id) ? [] : ['of another Feature'])];
		return `${idHtml(b.id, links)} <small>${notes.join(', ')}</small>`;
	});
	return `<p class="blockers">blocked by ${each.join(', ')}</p>`;
}

// A Ticket's acceptance criteria, folded until the person opens them
function criteriaHtml(body: string): string {
	const criteria = acceptanceCriteria(body);
	if (criteria === null) return '<p class="meta">no Acceptance criteria</p>';
	return `<details class="criteria"><summary>Acceptance criteria</summary><div class="md">${markdown(criteria)}</div></details>`;
}

function ticketHtml(ticket: Ticket, own: ReadonlySet<ItemId>, links: Links): string {
	const state = ticket.open ? 'open' : 'closed';
	return (
		`<li class="${state}"><p class="tk"><b>${idHtml(ticket.id, links)}</b> ${escape(ticket.title)} <small class="st">${state}</small></p>` +
		signalsHtml(ticket.signals, links) +
		blockersHtml(ticket, own, links) +
		criteriaHtml(ticket.body) +
		'</li>'
	);
}

// The panel for a Feature read well: its spec, then its Tickets in Build order.
export function featurePanel(detail: FeatureDetail, links: Links): string {
	const { feature, tickets } = detail;
	const lone = feature.lone === true;
	const own = new Set(tickets.map((t) => t.id));
	const spec =
		feature.body.trim() === ''
			? '<p class="empty">no spec</p>'
			: `<div class="md">${markdown(feature.body)}</div>`;
	const list =
		tickets.length === 0
			? '<p class="empty">no Tickets yet</p>'
			: `<ol class="steps">${tickets.map((t) => ticketHtml(t, own, links)).join('')}</ol>`;
	return (
		title(feature.id, feature.title, links) +
		(lone ? '<p class="sub">Lone issue: its body is both the spec and its one Ticket</p>' : '') +
		onTracker(feature.id, links) +
		`<section class="spec"><h3>Spec</h3>${spec}</section>` +
		`<section class="build"><h3>Tickets in Build order</h3>${list}</section>`
	);
}

// The panel for a Feature the Tracker could not give: why, and where to read it instead.
export function featureFault(id: ItemId, fault: unknown, links: Links): string {
	return (
		title(id, '', links) +
		`<p class="fault" role="alert">could not read ${escape(idText(id))} from the Tracker: ${escape(why(fault))}</p>` +
		onTracker(id, links)
	);
}

// The panel's frame on the page, outside the panels each event replaces, so an event never closes it.
export const FEATURE_DIALOG =
	'<dialog id="feature" aria-label="Feature" aria-labelledby="feature-title"><div class="fp"><div class="fp-bar"><p class="dk">Feature</p><button type="button" class="close" data-close>Close</button></div><div id="feature-body"></div></div></dialog>';

// The page's script for the panel: a Feature's title opens it, read from the Tracker as it opens; Close, Escape or a click beside it closes it, and focus goes back to the title.
// It sets the panel to the server's markup, which holds Tracker text only with its HTML stripped, or to text of its own. Wrapped in a function, so its names never meet the page's other scripts'.
export const FEATURE_SCRIPT = `(() => {
const dialog = document.getElementById('feature');
const content = document.getElementById('feature-body');
// counts the reads, so the answer to one since closed or left behind is dropped
let reading = 0;
let opener = null;
const unreachable = (id, href) => {
	content.textContent = '';
	const p = document.createElement('p');
	p.className = 'fault';
	p.setAttribute('role', 'alert');
	p.textContent = 'could not reach nightjar ui to read ' + id + '; is it still running?';
	content.appendChild(p);
	if (!href) return;
	const a = document.createElement('a');
	a.className = 'act ext';
	a.href = href;
	a.target = '_blank';
	a.rel = 'noreferrer noopener';
	a.textContent = 'Open it on the Tracker';
	const q = document.createElement('p');
	q.appendChild(a);
	content.appendChild(q);
};
const openFeature = async (button) => {
	const id = button.dataset.feature;
	const n = ++reading;
	opener = id;
	// the id beside the title links to the Feature on the Tracker
	const row = button.closest('.who, tr, li');
	const link = row && row.querySelector('a.ext[href]');
	const href = link ? link.getAttribute('href') : null;
	content.innerHTML = '<p class="empty">loading from the Tracker</p>';
	if (!dialog.open) dialog.showModal();
	try {
		const answer = await fetch('${FEATURE_PATH}?id=' + encodeURIComponent(id), { cache: 'no-store' });
		const html = await answer.text();
		if (n === reading) content.innerHTML = html;
	} catch {
		if (n === reading) unreachable(id, href);
	}
};
document.getElementById('panels').addEventListener('click', (e) => {
	const button = e.target && e.target.closest ? e.target.closest('button[data-feature]') : null;
	if (button) openFeature(button);
});
dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
// a click on the backdrop, beside the panel, closes it as Escape does
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => {
	reading++;
	// an event may have swapped the panels while it was open: focus the shown twin of its title
	const back = opener && Array.from(document.querySelectorAll('button[data-feature]')).find((b) => b.dataset.feature === opener && b.offsetParent !== null);
	if (back) back.focus();
	opener = null;
});
})();`;

// The answer to `GET /feature?id=…`: the panel, read from the Tracker now; a failed read is an error in the panel, never a write.
export async function featureAnswer(
	search: URLSearchParams,
	read: (id: ItemId) => Promise<FeatureDetail>,
	links: Links
): Promise<Answer> {
	const id = search.get('id') ?? '';
	if (id === '' || id.length > ID_MAX) {
		return { status: 400, body: '<p class="fault" role="alert">no Feature named</p>' };
	}
	try {
		return { status: 200, body: featurePanel(await read(id), links) };
	} catch (fault) {
		return { status: 502, body: featureFault(id, fault, links) };
	}
}
