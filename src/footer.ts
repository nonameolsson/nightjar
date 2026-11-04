// Nightjar's signature on every comment and reply it posts. It signs in as a person, often the reviewer, so the footer alone tells its words from theirs.
export const FOOTER = '\n\n---\n_Built by Nightjar._';

const SIGNATURE = FOOTER.trim();

// A host may store a body with CRLF line ends, or without the blank space at its end.
export function endsWithFooter(body: string): boolean {
	return body.replace(/\r\n/g, '\n').trimEnd().endsWith(SIGNATURE);
}

export function withFooter(body: string): string {
	return endsWithFooter(body) ? body : `${body}${FOOTER}`;
}

const QUOTED = 200;

// A reply that quotes the start of what it answers, for a comment that sits apart from it.
export function answerText(answered: string, body: string): string {
	// by code point, so a quote never ends inside an emoji
	const letters = Array.from(answered.trim());
	const start = letters.slice(0, QUOTED).join('') + (letters.length > QUOTED ? '…' : '');
	if (start === '') return withFooter(body);
	const quote = start
		.split('\n')
		.map((line) => `> ${line}`.trimEnd())
		.join('\n');
	return withFooter(`${quote}\n\n${body}`);
}
