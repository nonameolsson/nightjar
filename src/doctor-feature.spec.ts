// `nightjar doctor FEATURE` by its output, over a machine of stand-ins and a fake GitHub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machine, type Machine } from './fakes/machine.js';
import { FakeGitHub } from './github/fake-github.js';
import { runNightjar } from './main.js';

let out: string[];
let err: string[];
let m: Machine;
beforeEach(() => {
	out = [];
	err = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
	vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});
afterEach(() => {
	vi.restoreAllMocks();
	m.remove();
});

const GOOD = '### Acceptance criteria\n\n- [ ] it works\n';

// Feature #1 with a Ticket per body, in order, and a closed Ticket that has no criteria.
function feature(bodies: readonly string[], featureBody = ''): FakeGitHub {
	const github = new FakeGitHub('o/r', 'ann');
	const parent = github.issue({
		title: 'A Feature',
		body: featureBody,
		state: 'open',
		labels: ['factory-go'],
		assignees: ['ann']
	});
	for (const body of bodies) {
		const child = github.issue({
			title: 'A Ticket',
			body,
			state: 'open',
			labels: ['ready-for-agent'],
			assignees: ['ann']
		});
		github.addSubIssue(parent, child);
	}
	const closed = github.issue({
		title: 'Done',
		body: 'nothing',
		state: 'closed',
		labels: [],
		assignees: []
	});
	github.addSubIssue(parent, closed);
	return github;
}

const REVIEW = {
	steps: [{ name: 'critique', prompt: '/critique', point: 'afterAllTickets' }]
};

async function doctor(github: FakeGitHub, argv: string[], extra: Record<string, unknown> = {}) {
	m = machine();
	m.writeConfig({
		tracker: { type: 'github' },
		codeHost: { type: 'github' },
		check: 'make check',
		allowedCommands: ['make check'],
		...extra
	});
	return runNightjar(argv, { platform: 'linux', cwd: m.root, env: m.env, gh: github.gh });
}

describe('nightjar doctor FEATURE', () => {
	it('says ok for each open Ticket and exits 0 when every one passes', async () => {
		const github = feature([GOOD, `${GOOD}\n**Model:** opus\n`]);
		expect(await doctor(github, ['doctor', '1'])).toBe(0);
		expect(out).toEqual(['nightjar: #2: ok', 'nightjar: #3: ok']);
		expect(err).toEqual([]);
		expect(github.calls.filter((c) => c.method !== 'GET')).toEqual([]);
	});

	it('says each fault of a Ticket that fails, exits 1, and writes nothing', async () => {
		const github = feature([GOOD, 'no criteria here\n\n**Effort:**\n']);
		expect(await doctor(github, ['1', '--dry-run'])).toBe(1);
		expect(out[0]).toBe('nightjar: #2: ok');
		expect(out[1]).toMatch(
			/^nightjar: #3: .*Acceptance criteria.* Its \*\*Effort:\*\* line has no value/
		);
		expect(out).toHaveLength(2);
		expect(github.calls.filter((c) => c.method !== 'GET')).toEqual([]);
	});

	describe('across the Tickets', () => {
		const noWrites = (github: FakeGitHub) =>
			expect(github.calls.filter((c) => c.method !== 'GET')).toEqual([]);

		it('fails a Ticket blocked by an open issue outside the Feature', async () => {
			const github = feature([GOOD, GOOD]);
			const outside = github.issue({
				title: 'Elsewhere',
				body: '',
				state: 'open',
				labels: [],
				assignees: []
			});
			github.block(3, outside);
			expect(await doctor(github, ['doctor', '1'])).toBe(1);
			expect(out[0]).toBe('nightjar: #2: ok');
			expect(out[1]).toMatch(/^nightjar: #3: It is blocked by #5, which is open and not a Ticket/);
			expect(out).toHaveLength(2);
			noWrites(github);
		});

		it('passes a blocker that is closed or among the Feature’s Tickets', async () => {
			const github = feature([GOOD, GOOD]);
			// #4 is the Feature's closed Ticket; #2 is an open one
			github.block(3, 2);
			github.block(3, 4);
			const done = github.issue({
				title: 'Elsewhere, done',
				body: '',
				state: 'closed',
				labels: [],
				assignees: []
			});
			github.block(2, done);
			expect(await doctor(github, ['doctor', '1'])).toBe(0);
			expect(out).toEqual(['nightjar: #2: ok', 'nightjar: #3: ok']);
		});

		it('fails a blocking loop, naming each Ticket', async () => {
			const github = feature([GOOD, GOOD, GOOD]);
			github.block(2, 3);
			github.block(3, 2);
			expect(await doctor(github, ['doctor', '1'])).toBe(1);
			expect(out).toEqual([
				'nightjar: #2: ok',
				'nightjar: #3: ok',
				'nightjar: #4: ok',
				'nightjar: #1: The Tickets #2, #3 block each other in a loop, so none of them is built.'
			]);
			noWrites(github);
		});

		it('fails a Ticket that blocks itself, but not a chain', async () => {
			const github = feature([GOOD, GOOD]);
			github.block(2, 2);
			github.block(3, 2);
			expect(await doctor(github, ['doctor', '1'])).toBe(1);
			expect(out.at(-1)).toBe(
				'nightjar: #1: The Tickets #2 block each other in a loop, so none of them is built.'
			);
			expect(out).toHaveLength(3);
		});

		it('fails an open Ticket without the ready Signal', async () => {
			const github = new FakeGitHub('o/r', 'ann');
			const parent = github.issue({
				title: 'A Feature',
				body: '',
				state: 'open',
				labels: [],
				assignees: []
			});
			const child = github.issue({
				title: 'A Ticket',
				body: GOOD,
				state: 'open',
				labels: [],
				assignees: []
			});
			github.addSubIssue(parent, child);
			expect(await doctor(github, ['doctor', '1'])).toBe(1);
			expect(out).toEqual([
				'nightjar: #2: It does not carry the ready Signal, so a build skips it; give it the Signal or close it.'
			]);
			noWrites(github);
		});

		it('fails a Feature with no open Tickets', async () => {
			const github = feature([]);
			expect(await doctor(github, ['doctor', '1'])).toBe(1);
			expect(out).toEqual(['nightjar: #1: It has no open Ticket, so a build has nothing to do.']);
			noWrites(github);
		});

		it('fails a Workflow line naming a Workflow factory.json does not have', async () => {
			const github = feature([GOOD], '**Workflow:** design-review\n');
			expect(await doctor(github, ['doctor', '1'], { workflows: { review: REVIEW } })).toBe(1);
			expect(out).toEqual([
				'nightjar: #2: ok',
				'nightjar: #1: Its **Workflow:** line names `design-review`, which factory.json does not have. The Workflows known: review.'
			]);
			noWrites(github);
		});

		it('passes a Workflow line naming a Workflow factory.json has', async () => {
			const github = feature([GOOD], '**Workflow:** Review\n');
			expect(await doctor(github, ['doctor', '1'], { workflows: { review: REVIEW } })).toBe(0);
			expect(out).toEqual(['nightjar: #2: ok']);
		});
	});

	it('runs no machine check', async () => {
		const github = feature([GOOD]);
		expect(await doctor(github, ['doctor', '1', '--use-api-key'])).toBe(0);
		expect(out.join('\n')).not.toMatch(/claude|Node|git signing/);
	});
});
