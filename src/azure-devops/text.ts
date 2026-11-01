// A description or comment as Azure DevOps stores it, Markdown or HTML, made the plain text the agent and Ticket lines read.

const ENTITIES: Readonly<Record<string, string>> = {
	nbsp: ' ',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	amp: '&'
};

const decode = (text: string) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name.startsWith('#x') || name.startsWith('#X')) {
			return String.fromCodePoint(parseInt(name.slice(2), 16));
		}
		if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
		return ENTITIES[name.toLowerCase()] ?? whole;
	});

// HTML as the web editor writes it: blocks and breaks become lines, list items dashes, a link [text](address); other tags go.
function fromHtml(html: string): string {
	const text = html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<li\b[^>]*>/gi, '- ')
		.replace(/<\/(?:div|p|li|h[1-6]|tr|blockquote|pre|ul|ol)>/gi, '\n')
		.replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>(.*?)<\/a>/gis, '[$2]($1)')
		.replace(/<[^>]*>/g, '');
	return decode(text)
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// `format` is what Azure DevOps names it, "markdown" in any case; anything else is HTML.
export function plainText(value: string, format: string | null | undefined): string {
	// Azure DevOps keeps a bare < or > of Markdown as its entity
	if (format?.toLowerCase() === 'markdown') {
		return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
	}
	return fromHtml(value);
}
