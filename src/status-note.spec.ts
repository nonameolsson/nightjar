import { describe, expect, it } from 'vitest';
import { endsWithFooter } from './footer.js';
import {
	EXCERPT_LINES,
	STATE_WORDS,
	againSentence,
	buildingSentence,
	excerptOf,
	headline,
	logbookLine,
	readAgain,
	readStatusNote,
	statusNoteText,
	withEarlier,
	untilText,
	waitingCommentText,
	type NoteState,
	type StatusNote,
	type WaitingComment
} from './status-note.js';
import { STATUS_MARKER, isStatusNote } from './tracker.js';

const BARE: StatusNote = {
	state: 'building',
	sentence: 'Nightjar is building this Feature.',
	tickets: [],
	pull: null,
	next: null,
	earlier: [],
	logbook: { feature: '12', session: null }
};

const text = (more: Partial<StatusNote>) => statusNoteText({ ...BARE, ...more });

describe('buildingSentence', () => {
	const ticket = { place: 3, of: 5, title: 'Share the function' };

	it('names the Ticket and its place in the Feature', () => {
		expect(buildingSentence({ ticket })).toBe('Ticket 3 of 5: Share the function');
	});

	it('says a try after a passing fault, and which', () => {
		expect(buildingSentence({ ticket, retry: { attempt: 2, of: 3 } })).toBe(
			'Ticket 3 of 5: Share the function, retrying after a fault (try 2 of 3)'
		);
	});

	it('says the Ticket is built', () => {
		expect(buildingSentence({ ticket, built: true })).toBe(
			'Ticket 3 of 5 built: Share the function'
		);
	});

	it('names no Ticket of a Lone issue', () => {
		expect(buildingSentence({ ticket: null })).toBe('Nightjar is building this issue.');
		expect(buildingSentence({ ticket: null, retry: { attempt: 3, of: 3 } })).toBe(
			'Nightjar is building this issue, retrying after a fault (try 3 of 3).'
		);
	});
});

describe('a paused note', () => {
	it('says until when, in UTC, between the state word and the sentence', () => {
		const note = text({
			state: 'paused',
			until: '2026-10-30T09:30:00.000Z',
			sentence: 'The plan’s usage limit was reached.'
		});
		expect(note.split('\n')[1]).toBe(
			'**Paused** until 2026-10-30 09:30 UTC: The plan’s usage limit was reached.'
		);
	});

	it('gives no time when nothing tries the Feature again on its own', () => {
		expect(headline('paused', 'The day is over.')).toBe('**Paused**: The day is over.');
		expect(untilText('2026-10-30T21:05:59.000Z')).toBe('2026-10-30 21:05 UTC');
	});
});

describe('excerptOf', () => {
	it('keeps short output as it is, without colour codes or blank edges', () => {
		expect(excerptOf('\n\n\u001b[31mred\u001b[0m line\r\nsecond  \n\n')).toBe('red line\nsecond');
	});

	it('cuts long output to its end in at most 15 lines, with a line of … where it was cut', () => {
		const output = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1)}`).join('\n');
		const lines = excerptOf(output).split('\n');
		expect(lines).toHaveLength(EXCERPT_LINES);
		expect(lines[0]).toBe('…');
		expect(lines.at(-1)).toBe('line 40');
		expect(lines[1]).toBe('line 27');
	});

	it('does not cut output of exactly 15 lines', () => {
		const output = Array.from({ length: 15 }, (_, i) => `line ${String(i + 1)}`).join('\n');
		expect(excerptOf(output)).toBe(output);
	});

	it('is empty for output that holds nothing', () => {
		expect(excerptOf('  \n\n')).toBe('');
	});
});

describe('waitingCommentText', () => {
	const COMMENT: WaitingComment = {
		sentence: 'Nightjar built nothing: the setup command `make setup` failed.',
		cause: 'Nightjar ran it in the new worktree, and no Ticket was started.',
		next: ['Fix the setup command.', 'Then hand it back.'],
		logbook: { feature: '12', session: null }
	};

	it('lays out the headline, the cause, the Next step, the Logbook line and the footer, in that order', () => {
		const text = waitingCommentText(COMMENT);
		expect(text.split('\n')[0]).toBe(
			'**Waiting on you**: Nightjar built nothing: the setup command `make setup` failed.'
		);
		const order = [
			'**Waiting on you**',
			'Nightjar ran it in the new worktree',
			'**Next step**',
			'Logbook: nightjar ui → #12 (on the machine that ran it)',
			'_Built by Nightjar._'
		].map((part) => text.indexOf(part));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(endsWithFooter(text)).toBe(true);
	});

	it('is no Status note, so the page and the build loop take it for a comment', () => {
		expect(isStatusNote(waitingCommentText(COMMENT))).toBe(false);
	});

	it('quotes the end of the output in a code block when no pull request holds it', () => {
		const output = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1)}`).join('\n');
		const text = waitingCommentText({ ...COMMENT, output });
		const block = /```\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '';
		expect(block.split('\n')).toHaveLength(EXCERPT_LINES);
		expect(block).toContain('line 40');
		expect(block).not.toContain('line 1\n');
		// the excerpt comes before the Next step
		expect(text.indexOf('```')).toBeLessThan(text.indexOf('**Next step**'));
	});

	it('fences the output with more backticks than it holds, so it cannot end the block early', () => {
		const text = waitingCommentText({ ...COMMENT, output: 'a ``` b' });
		expect(text).toContain('````\na ``` b\n````');
	});

	it('quotes no output once a pull request exists, and links the pull request’s section instead', () => {
		const text = waitingCommentText({
			...COMMENT,
			output: 'FAIL src/a.spec.ts\nexpected 1 to be 2',
			pull: { url: 'https://example.test/o/app/pull/9', section: 'The check fails' }
		});
		expect(text).not.toContain('```');
		expect(text).not.toContain('expected 1 to be 2');
		expect(text).toContain(
			'The full report is in the pull request https://example.test/o/app/pull/9, in its “The check fails” section.'
		);
	});

	it('names a pull request that has no section of its own', () => {
		const pull = { url: 'https://example.test/o/app/pull/9' };
		const text = waitingCommentText({ ...COMMENT, pull });
		expect(text).toContain('The pull request: https://example.test/o/app/pull/9');
	});

	it('names the Session in its Logbook line once there is one', () => {
		const logbook = { feature: '12', session: 's-1' };
		expect(waitingCommentText({ ...COMMENT, logbook })).toContain(
			'Logbook: nightjar ui → #12 · session s-1 (on the machine that ran it)'
		);
	});

	it('opens with a hidden mark when it has one, so Nightjar finds it again', () => {
		const text = waitingCommentText({ ...COMMENT, mark: '<!-- nightjar:questions -->' });
		expect(text.startsWith('<!-- nightjar:questions -->\n**Waiting on you**: ')).toBe(true);
	});

	it('leaves out the Next step when there is none', () => {
		expect(waitingCommentText({ ...COMMENT, next: [] })).not.toContain('**Next step**');
	});

	it('holds no resume command and no stack trace of its own', () => {
		const text = waitingCommentText(COMMENT);
		expect(text).not.toContain('claude --resume');
		expect(text).not.toMatch(/\n\s+at .*\(.*:\d+:\d+\)/);
	});
});

describe('statusNoteText', () => {
	it('opens with the hidden marker, then the state word and the sentence', () => {
		const note = text({});
		expect(note.split('\n').slice(0, 2)).toEqual([
			STATUS_MARKER,
			'**Building**: Nightjar is building this Feature.'
		]);
		expect(isStatusNote(note)).toBe(true);
	});

	it('says each state by the Board’s word', () => {
		const words: Record<NoteState, string> = {
			building: 'Building',
			waiting: 'Waiting on you',
			paused: 'Paused',
			pull: 'Draft PR open',
			stopped: 'Stopped'
		};
		expect(STATE_WORDS).toEqual(words);
		for (const [state, word] of Object.entries(words) as [NoteState, string][]) {
			expect(text({ state, sentence: 'Why.' }).split('\n')[1]).toBe(`**${word}**: Why.`);
			expect(headline(state, 'Why.')).toBe(`**${word}**: Why.`);
		}
	});

	it('ends with the footer, so it is never taken as Feedback', () => {
		const notes = [
			text({}),
			text({
				state: 'pull',
				tickets: [{ id: '3', title: 'A', state: 'built' }],
				pull: { url: 'https://example.test/o/app/pull/9' },
				next: ['Review it.'],
				earlier: [{ at: '2026-11-20T10:00:00.000Z', state: 'stopped', sentence: 'Stopped.' }],
				logbook: { feature: '12', session: 'abc123' }
			})
		];
		for (const note of notes) {
			expect(endsWithFooter(note)).toBe(true);
			expect(note.endsWith('\n\n---\n_Built by Nightjar._')).toBe(true);
		}
	});

	it('lists the Tickets with their states, linking the comment that handed one back', () => {
		const note = text({
			tickets: [
				{ id: '3', title: 'Make the button', state: 'built' },
				{ id: '4', title: 'Wire the form', state: 'building' },
				{
					id: '5',
					title: 'Ask the server',
					state: 'waiting',
					why: 'needs info',
					handBack: 'https://example.test/o/app/issues/5#issuecomment-7'
				},
				{ id: '6', title: 'Show the answer', state: 'waiting', why: 'blocked by #5' }
			]
		});
		expect(note).toContain(
			[
				'**Tickets**',
				'',
				'- #3 Make the button: built',
				'- #4 Wire the form: building',
				'- #5 Ask the server: waiting, needs info ([why](https://example.test/o/app/issues/5#issuecomment-7))',
				'- #6 Show the answer: waiting, blocked by #5'
			].join('\n')
		);
	});

	it('lists no Tickets when there are none, as for a Lone issue, and no pull request before one opens', () => {
		const note = text({});
		expect(note).not.toContain('**Tickets**');
		expect(note).not.toContain('**Pull request**');
		expect(note).not.toContain('**Next step**');
		expect(note).not.toContain('**Earlier runs**');
	});

	it('links the pull request', () => {
		expect(text({ state: 'pull', pull: { url: 'https://example.test/o/app/pull/9' } })).toContain(
			'**Pull request**: https://example.test/o/app/pull/9'
		);
	});

	it('holds the Next step, numbered in its order', () => {
		expect(text({ next: ['Answer the questions above.', 'Then hand it back.'] })).toContain(
			'**Next step**\n\n1. Answer the questions above.\n2. Then hand it back.'
		);
	});

	it('keeps one line per earlier run, oldest first, by its day, state word and sentence', () => {
		const note = text({
			earlier: [
				{
					at: '2026-11-20T10:00:00.000Z',
					state: 'pull',
					sentence: 'Nightjar opened a draft pull request.'
				},
				{ at: '2026-11-22T08:30:00.000Z', state: 'stopped', sentence: 'A person stopped the run.' }
			]
		});
		expect(note).toContain(
			[
				'**Earlier runs**',
				'',
				'- 2026-11-20 · **Draft PR open**: Nightjar opened a draft pull request.',
				'- 2026-11-22 · **Stopped**: A person stopped the run.'
			].join('\n')
		);
	});

	it('ends its text with the Logbook line, naming the Session once there is one', () => {
		const before = text({});
		expect(before).toContain(
			'Logbook: nightjar ui → #12 (on the machine that ran it)\n\n---\n_Built by Nightjar._'
		);
		expect(text({ logbook: { feature: '12', session: 'abc123' } })).toContain(
			'Logbook: nightjar ui → #12 · session abc123 (on the machine that ran it)\n\n---'
		);
		expect(logbookLine({ feature: 'PROJ-4', session: 's-1' })).toBe(
			'Logbook: nightjar ui → #PROJ-4 · session s-1 (on the machine that ran it)'
		);
	});

	it('lays its parts out in order: headline, Tickets, pull request, Next step, earlier runs, Logbook', () => {
		const note = text({
			state: 'pull',
			sentence: 'Nightjar opened a draft pull request for this Feature.',
			tickets: [{ id: '3', title: 'A', state: 'built' }],
			pull: { url: 'https://example.test/o/app/pull/9' },
			next: ['Review it.'],
			earlier: [{ at: '2026-11-20T10:00:00.000Z', state: 'stopped', sentence: 'Stopped.' }],
			logbook: { feature: '12', session: 'abc123' }
		});
		const order = [
			'**Draft PR open**',
			'**Tickets**',
			'**Pull request**',
			'**Next step**',
			'**Earlier runs**',
			'Logbook:',
			'_Built by Nightjar._'
		].map((part) => note.indexOf(part));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it('keeps the time it was written in a hidden line under the headline, and only when it has one', () => {
		const at = '2026-11-22T08:30:00.000Z';
		expect(text({ at }).split('\n').slice(0, 3)).toEqual([
			STATUS_MARKER,
			'**Building**: Nightjar is building this Feature.',
			`<!-- nightjar:at ${at} -->`
		]);
		expect(isStatusNote(text({ at }))).toBe(true);
		expect(text({})).not.toContain('nightjar:at');
	});
});

describe('reading a Status note back', () => {
	const at = '2026-11-22T08:30:00.000Z';
	const earlier = [
		{ at: '2026-11-20T10:00:00.000Z', state: 'pull', sentence: 'Opened a draft.' },
		{ at: '2026-11-21T10:00:00.000Z', state: 'stopped', sentence: 'A person stopped it.' }
	] as const;

	it('gives the headline as a run, dated by the time the note kept', () => {
		const body = text({ state: 'waiting', sentence: 'A Ticket needs you.', at });
		expect(readStatusNote(body, 'unused')).toEqual({
			current: { at, state: 'waiting', sentence: 'A Ticket needs you.' },
			earlier: []
		});
	});

	it('dates the headline of an older note, one that kept no time, by the time it is given', () => {
		const got = readStatusNote(text({}), '2026-11-25T00:00:00.000Z');
		expect(got.current?.at).toBe('2026-11-25T00:00:00.000Z');
	});

	it('reads a Paused headline without its time', () => {
		const body = text({
			state: 'paused',
			until: '2026-10-30T09:30:00.000Z',
			sentence: 'The usage limit was reached.'
		});
		expect(readStatusNote(body, at).current).toEqual({
			at,
			state: 'paused',
			sentence: 'The usage limit was reached.'
		});
	});

	it('gives the Earlier runs oldest first, each by its day', () => {
		const got = readStatusNote(text({ earlier }), at).earlier;
		expect(got).toEqual([
			{ at: '2026-11-20', state: 'pull', sentence: 'Opened a draft.' },
			{ at: '2026-11-21', state: 'stopped', sentence: 'A person stopped it.' }
		]);
	});

	it('gives the same Earlier runs back after they are written again', () => {
		const once = readStatusNote(text({ earlier }), at).earlier;
		expect(readStatusNote(text({ earlier: once }), at).earlier).toEqual(once);
	});

	it('reads a note whose host stored it with CRLF line ends', () => {
		const body = text({ earlier, at }).replaceAll('\n', '\r\n');
		const got = readStatusNote(body, 'unused');
		expect(got.current?.at).toBe(at);
		expect(got.earlier.map((r) => r.state)).toEqual(['pull', 'stopped']);
	});

	it('reads nothing from text that is no Status note', () => {
		expect(readStatusNote('Happened again, 2 times.', at)).toEqual({ current: null, earlier: [] });
	});

	describe('withEarlier', () => {
		const line = { at, sentence: againSentence(2, '2026-11-03 12:00') };

		it('changes the Earlier runs and nothing else', () => {
			const body = text({ state: 'pull', next: ['Review it.'], earlier, at });
			const got = withEarlier(body, [...readStatusNote(body, at).earlier, line]);
			expect(got).toBe(
				body.replace(
					'- 2026-11-21 · **Stopped**: A person stopped it.',
					'- 2026-11-21 · **Stopped**: A person stopped it.\n- 2026-11-22 · Happened again, 2 times since 2026-11-03 12:00.'
				)
			);
		});

		it('adds the section before the Logbook line when the note has none', () => {
			const body = text({ at });
			const got = withEarlier(body, [line]);
			expect(got).toContain(
				'**Earlier runs**\n\n- 2026-11-22 · Happened again, 2 times since 2026-11-03 12:00.\n\nLogbook: '
			);
			expect(endsWithFooter(got)).toBe(true);
			expect(readStatusNote(got, at).current).toEqual(readStatusNote(body, at).current);
		});
	});

	describe('a "happened again" line', () => {
		it('says the count and since when, with no state word, and reads back the same', () => {
			const line = { at, sentence: againSentence(1, '2026-11-03 12:00') };
			expect(line.sentence).toBe('Happened again, 1 time since 2026-11-03 12:00.');
			expect(againSentence(3, 'x')).toBe('Happened again, 3 times since x.');
			const back = readStatusNote(text({ earlier: [line] }), at).earlier;
			expect(back).toEqual([{ at: '2026-11-22', sentence: line.sentence }]);
			expect(readAgain(line)).toEqual({ times: 1, since: '2026-11-03 12:00' });
			expect(back[0] === undefined ? null : readAgain(back[0])).toEqual({
				times: 1,
				since: '2026-11-03 12:00'
			});
		});

		it('is no run of the build: a run with a state word is never one', () => {
			expect(readAgain({ at, state: 'stopped', sentence: againSentence(2, 'x') })).toBeNull();
			expect(readAgain({ at, sentence: 'Something else.' })).toBeNull();
		});
	});
});
