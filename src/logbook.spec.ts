// The contract of the Logbook, run over both adapters: the files under .factory/logbook/ and memory.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryLogbook } from './fakes/logbook.js';
import { fileLogbook, logbookPath, noteFor, type Logbook, type LogbookEntry } from './logbook.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'nightjar-logbook-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (minute: number) => new Date(2026, 9, 30, 9, minute).toISOString();

const started: LogbookEntry = {
	at: at(0),
	feature: '1',
	kind: 'buildStarted',
	by: 'go',
	branch: 'factory/1-one-escape',
	workflow: null
};
const red: LogbookEntry = {
	at: at(5),
	feature: '1',
	kind: 'checkRed',
	report: 'lint: 1 problem',
	round: 1,
	rounds: 3,
	ticket: '2',
	session: 'session-1'
};

const adapters: [string, () => Logbook][] = [
	['file', () => fileLogbook(join(dir, 'app'))],
	['in-memory', () => memoryLogbook()]
];

describe.each(adapters)('the %s Logbook', (_name, make) => {
	it('has no Logbook for a Feature nothing was written for', () => {
		expect(make().read('1')).toBeNull();
	});

	it('gives back what was written for a Feature, oldest first', () => {
		const logbook = make();
		logbook.write(started);
		logbook.write(red);
		expect(logbook.read('1')).toEqual([started, red]);
	});

	it('keeps each Feature to its own Logbook', () => {
		const logbook = make();
		const other: LogbookEntry = { ...started, feature: 'PROJ-7', branch: 'factory/PROJ-7-other' };
		logbook.write(started);
		logbook.write(other);
		expect(logbook.read('1')).toEqual([started]);
		expect(logbook.read('PROJ-7')).toEqual([other]);
		expect(logbook.read('2')).toBeNull();
	});

	it('dates what a writer for one Feature notes, and files it under that Feature', () => {
		const logbook = make();
		const note = noteFor(logbook, '1', () => new Date(2026, 9, 30, 9, 3));
		note({ kind: 'signal', signal: 'needsInfo', on: true, ticket: '2' });
		note({ kind: 'paused', why: 'the day is over' });
		expect(logbook.read('1')).toEqual([
			{ at: at(3), feature: '1', kind: 'signal', signal: 'needsInfo', on: true, ticket: '2' },
			{ at: at(3), feature: '1', kind: 'paused', why: 'the day is over' }
		]);
	});
});

describe('the Logbook file', () => {
	it('is one JSON line per entry in .factory/logbook/, named by the Feature id', () => {
		const root = join(dir, 'app');
		const logbook = fileLogbook(root);
		logbook.write(started);
		logbook.write(red);
		const path = join(root, '.factory', 'logbook', '1.jsonl');
		expect(logbookPath(root, '1')).toBe(path);
		const lines = readFileSync(path, 'utf8').split('\n');
		expect(lines.slice(0, -1).map((l) => JSON.parse(l) as unknown)).toEqual([started, red]);
		expect(lines.at(-1)).toBe('');
	});

	it('keeps an id that is no plain file name to one file of its own', () => {
		const root = join(dir, 'app');
		const entry = { ...started, feature: '../a/b' };
		fileLogbook(root).write(entry);
		expect(existsSync(join(root, '.factory', 'logbook', '..%2Fa%2Fb.jsonl'))).toBe(true);
		expect(fileLogbook(root).read('../a/b')).toEqual([entry]);
	});

	it('skips a line that does not parse, or names no kind it knows', () => {
		const root = join(dir, 'app');
		const logbook = fileLogbook(root);
		logbook.write(started);
		appendFileSync(logbookPath(root, '1'), '{"at": "cut short\n');
		appendFileSync(logbookPath(root, '1'), `${JSON.stringify({ ...red, kind: 'unknown' })}\n`);
		appendFileSync(logbookPath(root, '1'), `${JSON.stringify({ ...red, round: 'one' })}\n`);
		appendFileSync(logbookPath(root, '1'), '\n');
		logbook.write(red);
		expect(logbook.read('1')).toEqual([started, red]);
	});
});
