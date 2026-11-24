// Tracker text as the page shows it: a small Markdown subset (headings, lists, checkboxes, code, quotes, links), with raw HTML stripped and every other character escaped, so a body can never put markup, a script or an event handler on the page.

export const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
// an element whose content is code or hidden text, dropped with its tag
const DROPPED =
	/<(script|style|iframe|object|embed|template|noscript|textarea|title|xmp|svg|math)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/\1\s*>/gi;
// a tag, its quoted attributes read whole so a `>` inside one cannot end it early
const TAG = /<\/?[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">])*>/g;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// a code span, which keeps what it holds as text
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

// A stand-in for a piece kept aside while the text around it is worked on: a private-use character, never in the text itself, as `markdown` and `inline` drop it.
const HOLD = String.fromCharCode(0xe000);
const held = (n: number) => `${HOLD}${String(n)}${HOLD}`;
const HELD = new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g');
const unheld = (text: string) => text.replaceAll(HOLD, '');

// HTML out of prose, outside its code spans; again until nothing changes, so `<<b>script>` cannot leave a tag behind
function stripHtml(prose: string): string {
	let text = prose;
	for (let i = 0; i < 5; i += 1) {
		const before = text;
		text = text.replace(COMMENT, '');
		const spans: string[] = [];
		text = text
			.replace(CODE_SPAN, (span) => {
				spans.push(span);
				return held(spans.length - 1);
			})
			.replace(DROPPED, '')
			.replace(TAG, '')
			.replace(HELD, (_, n: string) => spans[Number(n)] ?? '');
		if (text === before) break;
	}
	return text;
}

// The text with HTML stripped from everything but its fenced code blocks.
function withoutHtml(text: string): string {
	const out: string[] = [];
	let prose: string[] = [];
	let fence: string | null = null;
	const flush = () => {
		if (prose.length > 0) out.push(...stripHtml(prose.join('\n')).split('\n'));
		prose = [];
	};
	for (const line of text.split('\n')) {
		const f = FENCE.exec(line)?.[1];
		if (fence === null && f !== undefined) {
			flush();
			fence = f;
			out.push(line);
		} else if (fence !== null) {
			out.push(line);
			if (f !== undefined && f[0] === fence[0] && f.length >= fence.length) fence = null;
		} else prose.push(line);
	}
	flush();
	return out.join('\n');
}

// only a web address may be a link; a `javascript:` or `data:` one stays text
const safeHref = (href: string) => /^https?:\/\//i.test(href);

// Emphasis and links on text already escaped; a link is kept aside, so emphasis never reaches into its address.
function emphasis(escaped: string): string {
	const links: string[] = [];
	const text = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
		links.push(
			safeHref(href)
				? `<a class="ext" href="${href}" target="_blank" rel="noreferrer noopener">${strong(label)}</a>`
				: strong(label)
		);
		return held(links.length - 1);
	});
	return strong(text).replace(HELD, (_, n: string) => links[Number(n)] ?? '');
}

function strong(escaped: string): string {
	return escaped
		.replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, '<strong>$1</strong>')
		.replace(/__(?=\S)([^_]*?\S)__/g, '<strong>$1</strong>')
		.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1<em>$2</em>')
		.replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
}

// One line or paragraph of text as inline HTML: code spans first, as nothing inside one is Markdown.
export function inline(line: string): string {
	const text = unheld(line);
	let html = '';
	let at = 0;
	for (const m of text.matchAll(CODE_SPAN)) {
		html += emphasis(escapeHtml(text.slice(at, m.index)));
		html += `<code>${escapeHtml((m[2] ?? '').trim())}</code>`;
		at = m.index + m[0].length;
	}
	return html + emphasis(escapeHtml(text.slice(at)));
}

interface OpenList {
	readonly indent: number;
	readonly tag: 'ul' | 'ol';
}

// Markdown as HTML, safe to set as a page's markup: Tracker text is untrusted (docs/adr/0009).
export function markdown(source: string, depth = 0): string {
	const lines = withoutHtml(unheld(source).replace(/\r\n?/g, '\n')).split('\n');
	const out: string[] = [];
	let paragraph: string[] = [];
	const lists: OpenList[] = [];
	// a blank line inside a list: the next line goes on only when indented under its item
	let gap = false;
	const endParagraph = () => {
		if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
		paragraph = [];
	};
	const closeLists = (to = 0) => {
		while (lists.length > to) out.push(`</li></${lists.pop()?.tag ?? 'ul'}>`);
	};
	const endBlock = () => {
		endParagraph();
		closeLists();
		gap = false;
	};
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? '';
		const fence = FENCE.exec(line)?.[1];
		if (fence !== undefined) {
			endBlock();
			const code: string[] = [];
			for (i += 1; i < lines.length; i += 1) {
				const close = FENCE.exec(lines[i] ?? '')?.[1];
				if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) break;
				code.push(lines[i] ?? '');
			}
			out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
			continue;
		}
		if (line.trim() === '') {
			endParagraph();
			if (lists.length > 0) gap = true;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null) {
			endBlock();
			// the panel's own title is its top heading, so a body's headings sit beneath it
			const level = Math.min(6, (heading[1]?.length ?? 1) + 2);
			out.push(`<h${String(level)}>${inline(heading[2] ?? '')}</h${String(level)}>`);
			continue;
		}
		if (RULE.test(line)) {
			endBlock();
			out.push('<hr>');
			continue;
		}
		const item = ITEM.exec(line);
		if (item !== null) {
			endParagraph();
			const indent = (item[1] ?? '').replace(/\t/g, '    ').length;
			const tag = /\d/.test(item[2] ?? '') ? 'ol' : 'ul';
			gap = false;
			// close the lists deeper than this item, and one of the other kind at its depth
			const deeper = (l: OpenList) => l.indent > indent || (l.indent === indent && l.tag !== tag);
			while (lists.length > 0 && deeper(lists.at(-1) ?? { indent, tag })) {
				closeLists(lists.length - 1);
			}
			const same = lists.at(-1);
			if (same !== undefined && same.indent === indent) out.push('</li>');
			else {
				lists.push({ indent, tag });
				out.push(`<${tag}>`);
			}
			const text = item[3] ?? '';
			const task = TASK.exec(text);
			const box = task?.[1] === ' ' ? 'disabled' : 'disabled checked';
			out.push(
				task === null
					? `<li>${inline(text)}`
					: `<li class="task"><input type="checkbox" ${box}> ${inline(task[2] ?? '')}`
			);
			continue;
		}
		const quote = QUOTE.exec(line);
		if (quote !== null && depth < 4) {
			endBlock();
			const quoted = [quote[1] ?? ''];
			while (i + 1 < lines.length) {
				const next = QUOTE.exec(lines[i + 1] ?? '');
				if (next === null) break;
				quoted.push(next[1] ?? '');
				i += 1;
			}
			out.push(`<blockquote>${markdown(quoted.join('\n'), depth + 1)}</blockquote>`);
			continue;
		}
		if (lists.length > 0) {
			// text under an item goes on with it; after a blank line, only when indented under it
			const indent = /^\s*/.exec(line)?.[0].length ?? 0;
			if (!gap || indent > (lists.at(-1)?.indent ?? 0)) {
				out.push(` ${inline(line.trim())}`);
				gap = false;
				continue;
			}
			closeLists();
			gap = false;
		}
		paragraph.push(line.trim());
	}
	endBlock();
	return out.join('');
}
