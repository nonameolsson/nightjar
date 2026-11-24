import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { FakeTracker } from './fakes/tracker.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';
import { FEATURE_SCRIPT, featureAnswer, featurePanel } from './ui-feature.js';
import { NO_LINKS, type Links } from './ui-links.js';
import { detailFrom, readFeature } from './ui-tracker.js';

const links: Links = {
	...NO_LINKS,
	tracker: 'GitHub',
	issue: (id) => `https://github.com/o/app/issues/${id}`,
	signals: { ...DEFAULT_SIGNAL_NAMES, ready: 'agent-ready' }
};

const criteria = (text: string) => `Do it.\n\n### Acceptance criteria\n\n- [ ] ${text}`;

// #1 has four Tickets in its own order 2, 3, 4, 5: #2 waits for #4, #3 is closed, #5 waits for #99 of another Feature
const fakeTracker = () =>
	new FakeTracker('ann')
		.add({ id: '99', title: 'Elsewhere' })
		.add({
			id: '2',
			title: 'Share links',
			blockedBy: ['4'],
			signals: ['ready'],
			body: criteria('a link opens it')
		})
		.add({ id: '3', title: 'Model', open: false, body: criteria('it saves') })
		.add({ id: '4', title: 'Views list', signals: ['ready', 'needsInfo'], body: 'No criteria.' })
		.add({ id: '5', title: 'Export', blockedBy: ['99'], body: criteria('a CSV comes out') })
		.add({
			id: '1',
			title: 'Saved <views>',
			assignees: ['ann'],
			signals: ['go'],
			children: ['2', '3', '4', '5'],
			body: '## Problem\n\nA person sets the same filters **every day**.\n\n- one\n- two'
		})
		.add({ id: '7', title: 'Fix the typo', assignees: ['ann'], body: criteria('gone') });

// the parts of a panel: its spec, then each Ticket's item in the order shown
const spec = (html: string) => html.split('<section class="spec">')[1]?.split('</section>')[0];
const items = (html: string) =>
	(html.split('<section class="build">')[1] ?? '').split(/<li class="(?=open|closed)/).slice(1);

describe('the Feature detail panel', () => {
	it('lists the Tickets in Build order, each open or closed, with its Signals and what blocks it', async () => {
		const tracker = fakeTracker();
		const before = structuredClone([...tracker.items.values()]);
		const detail = await readFeature(tracker, '1');
		// #3 has no blocker, #4 then frees #2, and #5 waits on a Feature of another's, so it comes last
		expect(detail.tickets.map((t) => t.id)).toEqual(['3', '4', '2', '5']);
		const html = featurePanel(detail, links);
		const [model, views, share, exportTicket] = items(html);
		expect(model).toMatch(/^closed/);
		expect(model).toContain('Model');
		expect(model).toContain('no Signals');
		expect(views).toMatch(/^open/);
		// in the repo's own Signal names
		expect(views).toContain('<code>agent-ready</code> <code>needs-info</code>');
		expect(share).toContain('blocked by');
		expect(share).toContain('href="https://github.com/o/app/issues/4"');
		expect(share).toContain('<small>open</small>');
		expect(exportTicket).toContain('<small>open, of another Feature</small>');
		// read-only: nothing on the Tracker changed
		expect([...tracker.items.values()]).toEqual(before);
	});

	it('shows the spec as Markdown first, and a title as text', async () => {
		const html = featurePanel(await readFeature(fakeTracker(), '1'), links);
		expect(html.indexOf('<section class="spec">')).toBeLessThan(html.indexOf('class="build"'));
		expect(spec(html)).toContain('<h4>Problem</h4>');
		expect(spec(html)).toContain('<strong>every day</strong>');
		expect(spec(html)).toContain('<ul><li>one</li><li>two</li></ul>');
		expect(html).toContain('Saved &#60;views&#62;');
		expect(html).toContain('Open #1 on GitHub');
	});

	it("folds each Ticket's acceptance criteria until the person opens them", async () => {
		const html = featurePanel(await readFeature(fakeTracker(), '1'), links);
		const [model, views] = items(html);
		expect(model).toContain('<details class="criteria"><summary>Acceptance criteria</summary>');
		expect(model).toContain('<input type="checkbox" disabled> it saves');
		// a <details> left without `open` is folded
		expect(html).not.toMatch(/<details[^>]* open/);
		// only what is under the heading
		expect(model).not.toContain('Do it.');
		expect(views).toContain('no Acceptance criteria');
	});

	it("shows a lone issue's body as both its spec and its one Ticket", async () => {
		const html = featurePanel(await readFeature(fakeTracker(), '7'), links);
		expect(html).toContain('Lone issue');
		expect(spec(html)).toContain('Do it.');
		expect(spec(html)).toContain('gone');
		const tickets = items(html);
		expect(tickets).toHaveLength(1);
		expect(tickets[0]).toContain('Fix the typo');
		expect(tickets[0]).toContain('<input type="checkbox" disabled> gone');
	});

	it('keeps raw HTML, scripts and event handlers in a body off the page', async () => {
		const hostile = [
			'# Plan <script>alert(1)</script>',
			'<img src=x onerror="alert(2)"> <a href="javascript:alert(3)" onclick="alert(4)">here</a>',
			'<<b>script>alert(5)<</b>/script> <div onmouseover="alert(6)">hover</div>',
			'<img alt=">" onerror=alert(7)> [click](javascript:alert(8)) <!-- <script>alert(9)</script> -->',
			'<svg><script>alert(10)</script></svg> <iframe src="https://evil.example"></iframe>',
			'',
			'### Acceptance criteria',
			'',
			'- [x] <style>body{display:none}</style>shown <b onclick="alert(11)">bold</b>'
		].join('\n');
		const tracker = fakeTracker()
			.add({ id: '20', title: 'Ticket <b>bold</b>', body: hostile })
			.add({ id: '21', title: 'Bad', assignees: ['ann'], children: ['20'], body: hostile });
		const html = featurePanel(await readFeature(tracker, '21'), links);
		for (const bad of [
			'<script',
			'<img',
			'<svg',
			'<iframe',
			'<style',
			'onerror',
			'onclick',
			'onmouseover',
			'javascript:',
			'alert('
		])
			expect(html, bad).not.toContain(bad);
		// the panel's own wrapper is the only div
		expect(html).not.toMatch(/<div(?! class="md">)/);
		// what the Markdown says still shows, as text
		expect(spec(html)).toContain('<h3>Plan</h3>');
		expect(spec(html)).toContain('here');
		expect(spec(html)).toContain('click');
		expect(items(html)[0]).toContain('<input type="checkbox" disabled checked> shown bold');
		// a title is text, never markup
		expect(items(html)[0]).toContain('Ticket &#60;b&#62;bold&#60;/b&#62;');
	});

	it('answers a GET with the panel, an error with a link to the Feature on a failed read, and nothing without an id', async () => {
		const tracker = fakeTracker();
		const read = detailFrom(() => Promise.resolve({ tracker, person: 'ann' }));
		const ok = await featureAnswer(new URLSearchParams('id=1'), read, links);
		expect(ok.status).toBe(200);
		expect(ok.body).toContain('Tickets in Build order');
		const missing = await featureAnswer(new URLSearchParams('id=404'), read, links);
		expect(missing.status).toBe(502);
		expect(missing.body).toContain(
			'could not read #404 from the Tracker: the fake Tracker has no item #404'
		);
		expect(missing.body).toContain('href="https://github.com/o/app/issues/404"');
		const down = await featureAnswer(
			new URLSearchParams('id=1'),
			() => Promise.reject(new Error('gh: Bad <Gateway>')),
			links
		);
		expect(down.body).toContain('gh: Bad &#60;Gateway&#62;');
		expect(down.body).toContain('Open #1 on GitHub');
		const asked = async (query: string) =>
			(await featureAnswer(new URLSearchParams(query), read, links)).status;
		expect(await asked('')).toBe(400);
		expect(await asked(`id=${'x'.repeat(300)}`)).toBe(400);
	});
});

describe('the panel script', () => {
	// a stand-in page: one Feature title on the Board, the dialog, and a fetch that answers `answer`
	const page = (answer: () => Promise<string>) => {
		const on: Record<string, ((e: unknown) => void)[]> = {};
		const listen = (name: string) => (type: string, f: (e: unknown) => void) => {
			(on[`${name}:${type}`] ??= []).push(f);
		};
		const content = { innerHTML: '', textContent: '', appendChild: vi.fn() };
		const link = { getAttribute: () => 'https://github.com/o/app/issues/1' };
		const row = { querySelector: () => link };
		const title = {
			dataset: { feature: '1' },
			offsetParent: {},
			focus: vi.fn(),
			closest: (sel: string) => (sel.includes('data-feature') ? title : row)
		};
		const dialog = {
			open: false,
			showModal: vi.fn(() => {
				dialog.open = true;
			}),
			close: () => {
				dialog.open = false;
				for (const f of on['dialog:close'] ?? []) f({});
			},
			addEventListener: listen('dialog'),
			querySelector: () => ({ addEventListener: listen('close-button') })
		};
		const fetch = vi.fn(() => Promise.resolve({ text: answer }));
		const byId: Record<string, unknown> = {
			feature: dialog,
			'feature-body': content,
			panels: { addEventListener: listen('panels') }
		};
		runInNewContext(FEATURE_SCRIPT, {
			document: {
				getElementById: (id: string) => byId[id],
				querySelectorAll: () => [title],
				createElement: () => ({ setAttribute: () => {}, appendChild: () => {} })
			},
			fetch,
			encodeURIComponent
		});
		const fire = (name: string, type: string, e: unknown = {}) => {
			for (const f of on[`${name}:${type}`] ?? []) f(e);
		};
		return { fire, title, dialog, content, fetch };
	};

	it('opens the panel from a Feature title, reads it through the GET route, and closes it back to the title', async () => {
		const p = page(() => Promise.resolve('<h2 id="feature-title">Saved views</h2>'));
		// a click, or Enter or Space on the button, which the browser turns into a click
		p.fire('panels', 'click', { target: p.title });
		expect(p.dialog.showModal).toHaveBeenCalled();
		expect(p.fetch).toHaveBeenCalledWith('/feature?id=1', { cache: 'no-store' });
		await vi.waitFor(() => expect(p.content.innerHTML).toContain('Saved views'));
		// the Close button; Escape closes a modal dialog the same way
		p.fire('close-button', 'click');
		expect(p.dialog.open).toBe(false);
		expect(p.title.focus).toHaveBeenCalled();
	});

	it('says so in the panel, with a link to the Feature on the Tracker, when nightjar ui cannot be reached', async () => {
		const p = page(() => Promise.reject(new Error('offline')));
		p.fire('panels', 'click', { target: p.title });
		await vi.waitFor(() => expect(p.content.appendChild).toHaveBeenCalledTimes(2));
	});
});
