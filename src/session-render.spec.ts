import { describe, expect, it } from 'vitest';
import { renderSession } from './session-render.js';

const assistant = (...content: object[]) =>
	JSON.stringify({ type: 'assistant', message: { content } });
const user = (...content: object[]) => JSON.stringify({ type: 'user', message: { content } });
const text = (value: string) => ({ type: 'text', text: value });
const tool = (name: string, input: object) => ({ type: 'tool_use', id: 't1', name, input });
const result = (content: unknown) => ({ type: 'tool_result', tool_use_id: 't1', content });

const transcript = [
	JSON.stringify({ type: 'system', subtype: 'init' }),
	assistant(text('Reading the\nmarks module.')),
	assistant(tool('Read', { file_path: 'src/marks.ts' })),
	user(result('export const marks = 1')),
	assistant(tool('Bash', { command: 'npm test' }), tool('Edit', { file_path: 'src/x.ts' })),
	user(result([{ type: 'text', text: 'ok\n3 passed' }])),
	JSON.stringify({ type: 'result', result: 'done' })
];

describe('renderSession', () => {
	it('summary shows the text and one line per tool call, with its main argument', () => {
		expect(renderSession(transcript)).toEqual([
			{ kind: 'text', text: 'Reading the marks module.' },
			{ kind: 'tool', text: 'Read: src/marks.ts' },
			{ kind: 'tool', text: 'Bash: npm test' },
			{ kind: 'tool', text: 'Edit: src/x.ts' }
		]);
	});

	it('names a tool by its search pattern or url, and by itself when it has no main argument', () => {
		const lines = renderSession([
			assistant(
				tool('Grep', { pattern: 'marks', path: 'src' }),
				tool('WebFetch', { url: 'https://example.com/a' }),
				tool('TodoWrite', { todos: [] })
			)
		]);
		expect(lines.map((l) => l.text)).toEqual([
			'Grep: marks',
			'WebFetch: https://example.com/a',
			'TodoWrite'
		]);
	});

	it('cuts a tool call to one line', () => {
		const command = `cat <<EOF\n${'x'.repeat(500)}\nEOF`;
		const [line] = renderSession([assistant(tool('Bash', { command }))]);
		expect(line?.text).not.toContain('\n');
		expect(Array.from(line?.text ?? '')).toHaveLength(200);
		expect(line?.text.startsWith('Bash: cat <<EOF xxx')).toBe(true);
		expect(line?.text.endsWith('…')).toBe(true);
	});

	it('full mode adds each tool result, in order, and cuts a long one', () => {
		const long = user(result('y'.repeat(5000)));
		const lines = renderSession([...transcript, long], 'full');
		expect(lines.map((l) => [l.kind, l.text.slice(0, 20)])).toEqual([
			['text', 'Reading the marks mo'],
			['tool', 'Read: src/marks.ts'],
			['result', 'export const marks ='],
			['tool', 'Bash: npm test'],
			['tool', 'Edit: src/x.ts'],
			['result', 'ok\n3 passed'],
			['result', 'yyyyyyyyyyyyyyyyyyyy']
		]);
		const last = lines.at(-1)?.text ?? '';
		expect(Array.from(last).length).toBeLessThanOrEqual(2000);
		expect(last.endsWith('…')).toBe(true);
	});

	it('skips a line that does not parse, and a kind it does not know', () => {
		const lines = [
			'{"type":"assistant","message":',
			'not json',
			'',
			JSON.stringify({ type: 'rate_limit_event' }),
			JSON.stringify({ type: 'user', message: { content: 'a prompt as a string' } }),
			assistant({ type: 'thinking', thinking: 'hm' }, { type: 'image' }, text('kept'))
		];
		expect(renderSession(lines, 'full')).toEqual([{ kind: 'text', text: 'kept' }]);
	});
});
