// The Logbook reader over mock .factory/ files: the Feature's decisions joined with its Sessions from the ledger.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ledgerPath, record } from './ledger.js';
import {
	isSessionId,
	listLogbooks,
	readLogbook,
	readSession,
	sessionSummary,
	type LogbookItem
} from './logbook-reader.js';
import {
	fileLogbook,
	logbookPath,
	type Decision,
	type LogbookEntry,
	type Place
} from './logbook.js';
import type { Entry } from './spend.js';

let root: string;
beforeEach(() => {
	root = join(mkdtempSync(join(tmpdir(), 'nightjar-logbook-reader-')), 'app');
});
afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

const at = (minute: number) => new Date(2026, 9, 30, 9, minute).toISOString();

const session = (minute: number, over: Partial<Entry>): Entry => ({
	at: at(minute),
	repo: 'o/r',
	feature: '1',
	ticket: '2',
	branch: 'factory/1-one-escape',
	step: 'build',
	session: 'session-1',
	costUsd: 3,
	outcome: 'built',
	durationMs: 60_000,
	...over
});

const decision = (minute: number, entry: Decision & Place): LogbookEntry => ({
	at: at(minute),
	feature: '1',
	...entry
});

// each item in one line: a Session as `session <kind> <id>`, a decision by its kind
const line = (item: LogbookItem) =>
	item.kind === 'session'
		? `session ${item.session.kind} ${item.session.id}`
		: `${item.entry.kind}${item.entry.ticket ? ` #${item.entry.ticket}` : ''}`;

describe('readLogbook', () => {
	it("joins the Feature's decisions with its Sessions, in the order they happened", () => {
		const book = fileLogbook(root);
		book.write(
			decision(0, {
				kind: 'buildStarted',
				by: 'go',
				branch: 'factory/1-one-escape',
				workflow: null
			})
		);
		book.write(decision(0, { kind: 'ticketStarted', ticket: '2' }));
		record(ledgerPath(root), session(4, {}));
		// at the moment the build ended: about that Session, so after it
		book.write(
			decision(4, {
				kind: 'checkRed',
				report: 'lint: 1 problem',
				round: 1,
				rounds: 3,
				ticket: '2',
				session: 'session-1'
			})
		);
		record(ledgerPath(root), session(6, { step: 'fix', outcome: 'round 1', costUsd: 1 }));
		book.write(decision(7, { kind: 'ticketBuilt', commit: 'abc1234', ticket: '2' }));
		// another Feature's Session is not this one's
		record(ledgerPath(root), session(8, { feature: '9', session: 'session-9' }));
		record(
			ledgerPath(root),
			session(9, { ticket: null, step: 'review', session: 'session-2', outcome: 'approve' })
		);
		book.write(
			decision(9, {
				kind: 'review',
				verdict: 'approve',
				summary: 'Reads well.',
				issues: [],
				session: 'session-2'
			})
		);
		const url = 'https://code.example/pull/1';
		book.write(decision(10, { kind: 'pullOpened', url, created: true }));

		const view = readLogbook(root, '1');
		expect(view.feature).toBe('1');
		expect(view.recorded).toBe(true);
		expect(view.items.map(line)).toEqual([
			'buildStarted',
			'ticketStarted #2',
			'session build session-1',
			'checkRed #2',
			'session fix session-1',
			'ticketBuilt #2',
			'session review session-2',
			'review',
			'pullOpened'
		]);
	});

	it("gives each Session its kind, Ticket, outcome, cost, duration and transcript's path", () => {
		record(ledgerPath(root), session(4, {}));
		// a line written before durations were
		const { durationMs: _none, ...review } = session(9, {
			ticket: null,
			step: 'review',
			session: 'session-2',
			outcome: 'approve'
		});
		record(ledgerPath(root), review);
		const sessions = readLogbook(root, '1').items.flatMap((i) =>
			i.kind === 'session' ? [i.session] : []
		);
		expect(sessions).toEqual([
			{
				id: 'session-1',
				at: at(4),
				kind: 'build',
				ticket: '2',
				outcome: 'built',
				costUsd: 3,
				durationMs: 60_000,
				transcript: join(root, '.factory', 'logs', 'session-1.jsonl')
			},
			{
				id: 'session-2',
				at: at(9),
				kind: 'review',
				ticket: null,
				outcome: 'approve',
				costUsd: 3,
				transcript: join(root, '.factory', 'logs', 'session-2.jsonl')
			}
		]);
	});

	it('reads a Feature with ledger lines and no Logbook file as its Sessions only, with no decision recorded', () => {
		record(ledgerPath(root), session(4, {}));
		const view = readLogbook(root, '1');
		expect(view.recorded).toBe(false);
		expect(view.items.map(line)).toEqual(['session build session-1']);
	});

	it('reads a Feature nothing was recorded for as empty', () => {
		expect(readLogbook(root, '1')).toEqual({ feature: '1', recorded: false, items: [] });
	});

	it('skips a line of the Logbook that does not parse', () => {
		const book = fileLogbook(root);
		book.write(decision(0, { kind: 'paused', why: 'the day is over' }));
		appendFileSync(logbookPath(root, '1'), 'not json\n');
		book.write(decision(1, { kind: 'signal', signal: 'go', on: true }));
		expect(readLogbook(root, '1').items.map(line)).toEqual(['paused', 'signal']);
	});
});

describe('listLogbooks', () => {
	it('lists every Feature with a Logbook file or ledger lines, the one touched last first', () => {
		const book = fileLogbook(root);
		book.write(decision(0, { kind: 'paused', why: 'the day is over' }));
		record(ledgerPath(root), session(5, { costUsd: 2 }));
		record(ledgerPath(root), session(3, { feature: '7', session: 'session-7' }));
		book.write({ ...decision(9, { kind: 'madeBySource', source: 'sentry' }), feature: 'a/b' });
		expect(listLogbooks(root)).toEqual([
			{ feature: 'a/b', lastAt: at(9), sessions: 0, costUsd: 0, recorded: true },
			{ feature: '1', lastAt: at(5), sessions: 1, costUsd: 2, recorded: true },
			{ feature: '7', lastAt: at(3), sessions: 1, costUsd: 3, recorded: false }
		]);
	});

	it('lists nothing when nothing was recorded', () => {
		expect(listLogbooks(root)).toEqual([]);
	});

	it('lists no Feature for a Retro, which works on none', () => {
		const retro = { feature: '', ticket: null, branch: '', step: 'retro' as const };
		record(ledgerPath(root), session(4, { ...retro, outcome: 'proposed' }));
		expect(listLogbooks(root)).toEqual([]);
	});
});

describe('sessionSummary', () => {
	it("reads a Session's transcript as its text and tool calls, and nothing when it has none here", () => {
		record(ledgerPath(root), session(4, {}));
		const [item] = readLogbook(root, '1').items;
		if (item?.kind !== 'session') throw new Error('no Session');
		expect(sessionSummary(item.session)).toEqual([]);
		mkdirSync(join(root, '.factory', 'logs'), { recursive: true });
		const call = { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } };
		const result = { type: 'tool_result', tool_use_id: 't', content: 'ok' };
		const lines = [
			{ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading' }] } },
			{ type: 'assistant', message: { content: [call] } },
			{ type: 'user', message: { content: [result] } }
		];
		writeFileSync(item.session.transcript, lines.map((l) => JSON.stringify(l)).join('\n'));
		expect(sessionSummary(item.session)).toEqual([
			{ kind: 'text', text: 'Reading' },
			{ kind: 'tool', text: 'Bash: npm test' }
		]);
	});
});

describe('readSession', () => {
	const transcript = (id: string, lines: unknown[]) => {
		mkdirSync(join(root, '.factory', 'logs'), { recursive: true });
		writeFileSync(
			join(root, '.factory', 'logs', `${id}.jsonl`),
			lines.map((l) => JSON.stringify(l)).join('\n')
		);
	};
	const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });

	it('reads the transcript in full, tool results included, with the ledger lines of the Session', () => {
		transcript('session-1', [
			assistant({ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }),
			{
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }
			}
		]);
		record(ledgerPath(root), session(4, {}));
		record(ledgerPath(root), session(6, { step: 'fix', outcome: 'round 1' }));
		record(ledgerPath(root), session(8, { session: 'session-2' }));
		const read = readSession(root, 'session-1');
		expect(read?.lines).toEqual([
			{ kind: 'tool', text: 'Bash: npm test' },
			{ kind: 'result', text: 'ok' }
		]);
		expect(read?.runs.map((r) => [r.feature, r.kind, r.outcome])).toEqual([
			['1', 'build', 'built'],
			['1', 'fix', 'round 1']
		]);
	});

	it('has no runs for a Session the ledger does not know, and none at all without a transcript', () => {
		transcript('session-1', [assistant({ type: 'text', text: 'hi' })]);
		expect(readSession(root, 'session-1')?.runs).toEqual([]);
		record(ledgerPath(root), session(4, { session: 'session-3' }));
		expect(readSession(root, 'session-3')).toBeNull();
	});

	it('opens only a file named by a Session id', () => {
		expect(['a', 'A-1_b', 'a'.repeat(128)].map(isSessionId)).toEqual([true, true, true]);
		for (const id of ['', '..', 'a/b', 'a.b', '../logs/x', 'a b', 'a\n', 'a'.repeat(129)])
			expect([id, isSessionId(id)]).toEqual([id, false]);
		expect(readSession(root, '../runs')).toBeNull();
	});
});
