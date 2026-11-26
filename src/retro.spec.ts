// The Retro over a fake Coding agent and the in-memory ledger: what it reads, what it spends, and what it writes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RetroOutcome, RetroRequest } from './coding-agent.js';
import { readFeatureFile } from './feature-file.js';
import { memorySpend } from './fakes/spend.js';
import { FakeTracker } from './fakes/tracker.js';
import { failuresIn, isFailure, retroFile, runRetro, type RetroDeps } from './retro.js';
import type { Entry } from './spend.js';

const NOW = new Date('2026-11-26T12:00:00Z');
const DAY_MS = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-retro-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entry = (over: Partial<Entry> = {}): Entry => ({
	at: ago(DAY_MS),
	repo: 'o/app',
	feature: '1',
	ticket: '2',
	branch: 'factory/1-one-escape',
	step: 'build',
	session: 's-1',
	costUsd: 1.5,
	outcome: 'failed: it ran past 60 minutes',
	failure: 'budget',
	...over
});

const FILE = `# Name the check in CLAUDE.md

The Sessions could not find the check.

## Ticket 1: Name the check in CLAUDE.md

### Acceptance criteria

- [ ] CLAUDE.md names the check
`;

const proposed: RetroOutcome = {
	kind: 'proposed',
	summary: 'Name the check.',
	featureFile: FILE,
	sessionId: 's-retro',
	costUsd: 0.75
};

// A Retro over `entries`, whose Session answers `answer`; what it asked, said and recorded is kept.
function retro(
	entries: readonly Entry[],
	answer: RetroOutcome = proposed,
	over: Partial<RetroDeps> = {}
) {
	const spend = memorySpend();
	for (const e of entries) spend.record(e);
	const asked: RetroRequest[] = [];
	const said: string[] = [];
	const errors: string[] = [];
	const deps: RetroDeps = {
		root,
		repo: 'o/app',
		agent: {
			retro: (req) => {
				asked.push(req);
				return Promise.resolve(answer);
			}
		},
		spend,
		dailyUsd: 50,
		now: () => NOW,
		newId: () => 's-retro',
		say: (line) => said.push(line),
		error: (line) => errors.push(line),
		...over
	};
	return { run: () => runRetro(deps), spend, asked, said, errors };
}

describe('which Sessions a Retro reads', () => {
	it.each([
		['failed: it ran past 60 minutes', true],
		['questions, round 1', true],
		['round 2 gave up', true],
		['looks: blocked', true],
		['pull checks 1 failed: it reached its budget', true],
		['built', false],
		['approve', false],
		['paused: the daily limit', false],
		['stopped by a person', false],
		['failed: stopped by a person', false]
	])('%s: %s', (outcome, read) => {
		expect(isFailure(entry({ outcome, failure: undefined }))).toBe(read);
	});

	it('reads a line with a failure whatever its outcome says, and never a Retro', () => {
		expect(isFailure(entry({ outcome: 'odd', failure: 'lasting' }))).toBe(true);
		expect(isFailure(entry({ step: 'retro', outcome: 'failed: x' }))).toBe(false);
	});

	it('reads the last 30 days only, oldest first', () => {
		const old = entry({ session: 'old', at: ago(31 * DAY_MS) });
		const a = entry({ session: 'a', at: ago(2 * DAY_MS) });
		const b = entry({ session: 'b' });
		const built = entry({ session: 'c', outcome: 'built', failure: undefined });
		expect(failuresIn([old, a, built, b], NOW).map((e) => e.session)).toEqual(['a', 'b']);
	});
});

describe('nightjar retro', () => {
	it('starts no Session and says so when nothing failed in 30 days', async () => {
		const built = entry({ outcome: 'built', failure: undefined });
		const { run, asked, said, spend } = retro([built]);
		expect(await run()).toBe(0);
		expect(asked).toEqual([]);
		expect(said).toEqual([
			'no Session failed or was handed back in the last 30 days, so the retro has nothing to read and started no Session'
		]);
		expect(spend.entries()).toHaveLength(1);
	});

	it('hands one Session each failure with the end of its transcript, at $3 and 10 minutes', async () => {
		mkdirSync(join(root, '.factory', 'logs'), { recursive: true });
		const text = { type: 'text', text: 'No check.' };
		const said = { type: 'assistant', message: { content: [text] } };
		writeFileSync(join(root, '.factory', 'logs', 's-1.jsonl'), `${JSON.stringify(said)}\n`);
		const { run, asked } = retro([entry()]);
		await run();
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({
			kind: 'retro',
			sessionId: 's-retro',
			folder: root,
			budgetUsd: 3,
			minutes: 10,
			days: 30,
			more: 0
		});
		expect(asked[0]?.failures).toEqual([
			{
				session: 's-1',
				at: entry().at,
				feature: '1',
				ticket: '2',
				step: 'build',
				outcome: 'failed: it ran past 60 minutes',
				costUsd: 1.5,
				transcript: '.factory/logs/s-1.jsonl',
				tail: 'No check.'
			}
		]);
	});

	it('lists the latest 20 failures and counts the rest', async () => {
		const many = Array.from({ length: 23 }, (_, i) =>
			entry({ session: `s-${String(i)}`, at: ago((23 - i) * 1000) })
		);
		const { run, asked } = retro(many);
		await run();
		const listed = asked[0]?.failures.map((f) => f.session) ?? [];
		expect(listed.slice(0, 2)).toEqual(['s-3', 's-4']);
		expect(listed).toHaveLength(20);
		expect(asked[0]?.more).toBe(3);
	});

	it('writes the Feature file under .factory/plans, which nightjar create reads, and records its cost', async () => {
		const { run, spend, said } = retro([entry()]);
		expect(await run()).toBe(0);
		const text = readFileSync(join(root, '.factory', 'plans', 'retro-2026-11-26.md'), 'utf8');
		expect(text).toBe(FILE);
		expect(readFeatureFile(text).feature.title).toBe('Name the check in CLAUDE.md');
		expect(said).toContain(
			'wrote .factory/plans/retro-2026-11-26.md: Name the check in CLAUDE.md, 1 Ticket'
		);
		expect(said).toContain(
			'read it, then make it with: nightjar create .factory/plans/retro-2026-11-26.md'
		);
		expect(spend.entries().at(-1)).toEqual({
			at: NOW.toISOString(),
			repo: 'o/app',
			feature: '',
			ticket: null,
			branch: '',
			step: 'retro',
			session: 's-retro',
			costUsd: 0.75,
			outcome: 'proposed',
			durationMs: 0
		});
		// the Retro's own cost counts against the day
		expect(spend.today(NOW)).toBe(0.75);
	});

	it('never writes over an earlier Retro of the same day', () => {
		mkdirSync(join(root, '.factory', 'plans'), { recursive: true });
		writeFileSync(join(root, '.factory', 'plans', 'retro-2026-11-26.md'), 'edited');
		expect(retroFile(root, NOW)).toBe('.factory/plans/retro-2026-11-26-2.md');
	});

	it('gets what is left of the day when that is under $3', async () => {
		const today = entry({ at: NOW.toISOString(), outcome: 'built', failure: undefined });
		const { run, asked } = retro([entry(), { ...today, costUsd: 48 }]);
		await run();
		expect(asked[0]?.budgetUsd).toBe(2);
	});

	it('starts no Session once the day has reached its limit', async () => {
		const today = entry({ at: NOW.toISOString(), costUsd: 50 });
		const { run, asked, errors } = retro([today]);
		expect(await run()).toBe(1);
		expect(asked).toEqual([]);
		expect(errors).toEqual([
			"no retro: today's estimated spend, $50.00, reached the daily limit of $50.00"
		]);
	});

	it('writes the file and names each fault when the answer is no Feature file nightjar create takes', async () => {
		const tracker = new FakeTracker();
		const bad: RetroOutcome = { ...proposed, featureFile: '# A title\n\nNo Ticket.' };
		const { run, errors } = retro([entry()], bad, {
			create: { writer: tracker, go: 'factory-go' }
		});
		expect(await run()).toBe(1);
		expect(errors).toEqual([
			'wrote .factory/plans/retro-2026-11-26.md, but nightjar create would refuse it:',
			'.factory/plans/retro-2026-11-26.md: the file holds no Ticket; start each with "## Ticket 1: Title"'
		]);
		expect(existsSync(join(root, '.factory', 'plans', 'retro-2026-11-26.md'))).toBe(true);
		expect(tracker.items.size).toBe(0);
	});

	it('with --create, makes the Feature with no Signal and its Tickets ready', async () => {
		const tracker = new FakeTracker();
		const { run, said } = retro([entry()], proposed, {
			create: { writer: tracker, go: 'factory-go' }
		});
		expect(await run()).toBe(0);
		expect(tracker.items.get('1')).toMatchObject({
			title: 'Name the check in CLAUDE.md',
			signals: [],
			assignees: []
		});
		expect(tracker.items.get('2')?.signals).toEqual(['ready']);
		expect(said).toContain(
			'#1 carries no Signal: assign it to yourself and give it the Go (factory-go) to build it.'
		);
	});

	it('writes no file when the Session proposes nothing', async () => {
		const nothing: RetroOutcome = {
			kind: 'nothing',
			summary: 'Each was a network fault.',
			sessionId: 's-retro',
			costUsd: 0.25
		};
		const { run, said, spend } = retro([entry()], nothing);
		expect(await run()).toBe(0);
		expect(said).toContain('the retro proposes no change: Each was a network fault.');
		expect(existsSync(join(root, '.factory', 'plans'))).toBe(false);
		const last = spend.entries().at(-1);
		expect(last).toMatchObject({ step: 'retro', outcome: 'nothing to propose', costUsd: 0.25 });
	});

	it('records a Session that failed, with why, and writes no file', async () => {
		const failed: RetroOutcome = {
			kind: 'failed',
			why: 'it reached its budget',
			failure: 'budget',
			sessionId: 's-retro',
			costUsd: 3
		};
		const { run, errors, spend } = retro([entry()], failed);
		expect(await run()).toBe(1);
		expect(errors).toEqual(["the retro's Session failed: it reached its budget"]);
		expect(spend.entries().at(-1)).toMatchObject({
			step: 'retro',
			outcome: 'failed: it reached its budget',
			failure: 'budget',
			costUsd: 3
		});
		expect(existsSync(join(root, '.factory', 'plans'))).toBe(false);
	});
});
