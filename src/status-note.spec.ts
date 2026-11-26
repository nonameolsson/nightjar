import { describe, expect, it } from 'vitest';
import { endsWithFooter } from './footer.js';
import {
	STATE_WORDS,
	headline,
	logbookLine,
	statusNoteText,
	type NoteState,
	type StatusNote
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
});
