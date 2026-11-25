// One rendering of a Session's transcript (`.factory/logs/<session>.jsonl`, the Coding agent's stream-json) for every view.
import { z } from 'zod';

// summary: the Coding agent's text and one line per tool call; full: each tool result as well
export type SessionMode = 'summary' | 'full';

export interface SessionLine {
	readonly kind: 'text' | 'tool' | 'result';
	readonly text: string;
}

// a tool call is cut to this many characters so it stays one line
const CALL_MAX = 200;
// a tool result is cut to this many characters
const RESULT_MAX = 2000;

// The argument that says most about a tool call, the first of these that the call has.
const MAIN_ARGUMENTS = [
	'command',
	'file_path',
	'notebook_path',
	'pattern',
	'path',
	'url',
	'query',
	'description'
];

const Line = z.looseObject({
	type: z.string(),
	message: z.looseObject({ content: z.unknown() }).optional()
});
const Blocks = z.array(z.looseObject({ type: z.string() }));
const Text = z.looseObject({ text: z.string() });
const ToolUse = z.looseObject({
	name: z.string(),
	input: z.record(z.string(), z.unknown()).optional()
});
const ToolResult = z.looseObject({ content: z.unknown().optional() });

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

const cut = (text: string, max: number) => {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

function call(name: string, input: Record<string, unknown> | undefined): string {
	for (const key of MAIN_ARGUMENTS) {
		const value = input?.[key];
		if (typeof value === 'string' && oneLine(value) !== '') {
			return cut(`${name}: ${oneLine(value)}`, CALL_MAX);
		}
	}
	return cut(name, CALL_MAX);
}

// A tool result's content is a string or a list of text blocks.
function resultText(content: unknown): string {
	if (typeof content === 'string') return content;
	const blocks = z.array(z.looseObject({ text: z.string().optional() })).safeParse(content);
	return blocks.success ? blocks.data.map((b) => b.text ?? '').join('\n') : '';
}

function shown(raw: string, mode: SessionMode): SessionLine[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	const line = Line.safeParse(value);
	if (!line.success) return [];
	const { type } = line.data;
	if (type !== 'assistant' && !(type === 'user' && mode === 'full')) return [];
	const blocks = Blocks.safeParse(line.data.message?.content);
	if (!blocks.success) return [];
	const out: SessionLine[] = [];
	for (const block of blocks.data) {
		if (type === 'assistant' && block.type === 'text') {
			const got = Text.safeParse(block);
			if (got.success && oneLine(got.data.text) !== '') {
				out.push({ kind: 'text', text: oneLine(got.data.text) });
			}
		} else if (type === 'assistant' && block.type === 'tool_use') {
			const got = ToolUse.safeParse(block);
			if (got.success) out.push({ kind: 'tool', text: call(got.data.name, got.data.input) });
		} else if (type === 'user' && block.type === 'tool_result') {
			const got = ToolResult.safeParse(block);
			const text = got.success ? resultText(got.data.content).trim() : '';
			if (text !== '') out.push({ kind: 'result', text: cut(text, RESULT_MAX) });
		}
	}
	return out;
}

// What a view shows of a transcript, in order. A line that does not parse, or a kind this does not know, is skipped.
export function renderSession(
	lines: readonly string[],
	mode: SessionMode = 'summary'
): SessionLine[] {
	return lines.flatMap((raw) => shown(raw, mode));
}
