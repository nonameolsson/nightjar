// A Source's template: a Feature file with {{ placeholders }}, filled from an event's payload, which is untrusted data.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	FeatureFileError,
	firstTicketLine,
	readFeatureFile,
	type FeaturePlan
} from './feature-file.js';
import { why } from './say.js';

export class TemplateError extends Error {}

// the most characters a value of the payload may take in the Feature
export const VALUE_LIMIT = 200;

// the most bytes of the payload that join the Feature body
export const PAYLOAD_LIMIT = 8 * 1024;

export const PAYLOAD_HEADING = 'Event payload (untrusted data)';

// The templates Nightjar ships sit at the package's root, from src/ and from dist/ alike.
const SHIPPED = fileURLToPath(new URL('../templates/', import.meta.url));

// {{ date }}, {{ source }} or a plain path into the payload, as in {{ data.issue.title }}; no logic
const PLACEHOLDER = /\{\{\s*([\w$@-]+(?:\.[\w$@-]+)*)\s*\}\}/g;

const HTML: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

// the characters Markdown reads as marks
const MARKDOWN = /[\\`*_[\]()#|~!]/;

// control characters, and the invisible marks that turn text around
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

// what decoding a cut inside a character leaves behind
const REPLACEMENT = String.fromCodePoint(0xfffd);

// the opening of a line the build reads: a setting of a Ticket, its blockers, its Workflow
const LABEL = /^\W*(?:model|effort|blocked by|workflow|status)\s*:/i;

function escaped(char: string): string {
	const html = HTML[char];
	if (html !== undefined) return html;
	return MARKDOWN.test(char) ? `\\${char}` : char;
}

// a value as text: a string as it is, a number or boolean as written, an object as JSON, nothing as nothing
function written(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

// One line of at most VALUE_LIMIT characters, with HTML and Markdown escaped, so the value is text and nothing else.
export function cleanValue(value: unknown): string {
	const text = written(value).replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
	const pieces = Array.from(text, escaped);
	// a value that opens as a line the build reads (**Model:**, **Blocked by:**) is no such line
	const label = LABEL.exec(text);
	if (label !== null) pieces[Array.from(label[0]).length - 1] = '\\:';
	if (pieces.join('').length <= VALUE_LIMIT) return pieces.join('');
	let out = '';
	for (const piece of pieces) {
		// one character is left for the mark of the cut
		if (out.length + piece.length > VALUE_LIMIT - 1) break;
		out += piece;
	}
	return `${out}…`;
}

// The value at a path such as data.issue.title, with a number to step into a list; undefined when the payload has none.
export function lookup(payload: unknown, path: string): unknown {
	let at = payload;
	for (const step of path.split('.')) {
		if (Array.isArray(at)) {
			at = /^\d+$/.test(step) ? (at[Number(step)] as unknown) : undefined;
		} else if (typeof at === 'object' && at !== null && Object.hasOwn(at, step)) {
			at = (at as Record<string, unknown>)[step];
		} else return undefined;
	}
	return at;
}

// The key of an event: the clean value at the Source's key path; empty when there is no path or the payload has none.
export function eventKey(payload: unknown, path: string | undefined): string {
	return path === undefined ? '' : cleanValue(lookup(payload, path));
}

// The hidden marker on each Feature a Source makes, by which the Tracker is searched.
export const sourceMarker = (source: string, key: string): string =>
	`<!-- nightjar:source=${source} key=${key} -->`;

// The text a Tracker searches a Feature's body for: the marker of the Source up to its key, which no punctuation of a key can spoil.
export const markerSearch = (source: string): string => `nightjar:source=${source}`;

const MARKER = /<!-- nightjar:source=(\S+) key=(.*?) -->/;

export interface Marker {
	readonly source: string;
	readonly key: string;
}

// The Source and key of the first marker in a Feature's body, as `sourceMarker` writes them; null when it has none.
export function readMarker(body: string): Marker | null {
	const found = MARKER.exec(body);
	return found === null ? null : { source: found[1] ?? '', key: found[2] ?? '' };
}

const pad = (n: number) => String(n).padStart(2, '0');

// the date as the machine's calendar has it, as a schedule counts days
const today = (now: Date) =>
	`${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

// The payload as pretty JSON of at most PAYLOAD_LIMIT bytes, with no `<` that could write a marker or a tag.
function payloadText(payload: unknown): { readonly text: string; readonly cut: boolean } {
	const whole = (JSON.stringify(payload, null, 2) as string | undefined) ?? 'null';
	const json = whole.replace(/</g, '\\u003c');
	const bytes = Buffer.from(json, 'utf8');
	if (bytes.length <= PAYLOAD_LIMIT) return { text: json, cut: false };
	let text = bytes.subarray(0, PAYLOAD_LIMIT).toString('utf8');
	while (text.endsWith(REPLACEMENT)) text = text.slice(0, -1);
	return { text, cut: true };
}

export interface FillRequest {
	// the template's text, a Feature file with placeholders
	readonly template: string;
	// the Source's name
	readonly source: string;
	// the event's payload as it was parsed; none for a schedule
	readonly payload?: unknown;
	// the Source's `key`: a path into the payload
	readonly key?: string | undefined;
	readonly now?: Date;
}

export interface FilledTemplate {
	// a Feature file, which `readFeatureFile` reads
	readonly text: string;
	readonly plan: FeaturePlan;
	// what says when two events are the same; empty when the Source has no key or the payload no value there
	readonly key: string;
}

// The Feature file the template makes for one event, or a FeatureFileError that names what is out of shape.
export function fillTemplate({
	template,
	source,
	payload,
	key,
	now = new Date()
}: FillRequest): FilledTemplate {
	// one pass, so a value is never read for placeholders of its own
	const filled = template.replace(PLACEHOLDER, (_whole, path: string) => {
		if (path === 'date') return today(now);
		if (path === 'source') return cleanValue(source);
		return cleanValue(lookup(payload, path));
	});
	const eventKeyText = eventKey(payload, key);
	const lines = filled.replace(/\r\n/g, '\n').split('\n');
	const end = firstTicketLine(lines);
	const head = lines.slice(0, end);
	while (head.length > 0 && head.at(-1)?.trim() === '') head.pop();
	const added = ['', `**Source:** ${source}`, sourceMarker(source, eventKeyText)];
	if (payload !== undefined) {
		const { text, cut } = payloadText(payload);
		added.push(
			'',
			`**${PAYLOAD_HEADING}**`,
			'',
			'```json',
			text,
			'```',
			...(cut ? ['', `The payload was cut at ${String(PAYLOAD_LIMIT / 1024)} KB.`] : [])
		);
	}
	const text = `${[...head, ...added, '', ...lines.slice(end)].join('\n').trimEnd()}\n`;
	return { text, plan: readFeatureFile(text), key: eventKeyText };
}

// A template named by a path from the repo's root, which ends in .md or holds a slash; else the name of one Nightjar ships.
export function templatePath(root: string, name: string): string {
	if (!name.includes('/') && !name.endsWith('.md')) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new TemplateError(`${name} names no template`);
		return join(SHIPPED, `${name}.md`);
	}
	if (isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
		throw new TemplateError(`${name} must be a path inside the repo`);
	}
	return join(root, name);
}

export function readTemplate(root: string, name: string): string {
	const path = templatePath(root, name);
	try {
		return readFileSync(path, 'utf8');
	} catch {
		const shipped = !name.includes('/') && !name.endsWith('.md');
		throw new TemplateError(
			shipped
				? `Nightjar ships no template ${name}; name a Feature file from the repo's root, such as .nightjar/${name}.md`
				: `cannot read the template ${name} in ${root}`
		);
	}
}

// What is wrong with a Source's template, one fault to a line; none when it fills with an empty payload into a Feature file.
export function templateFaults(root: string, name: string): string[] {
	let template: string;
	try {
		template = readTemplate(root, name);
	} catch (fault) {
		return [why(fault)];
	}
	try {
		fillTemplate({ template, source: 'source', payload: {} });
		return [];
	} catch (fault) {
		if (fault instanceof FeatureFileError) return fault.message.split('\n');
		throw fault;
	}
}
