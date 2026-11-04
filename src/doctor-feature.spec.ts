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
function feature(bodies: readonly string[]): FakeGitHub {
	const github = new FakeGitHub('o/r', 'ann');
	const parent = github.issue({
		title: 'A Feature',
		body: '',
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

async function doctor(github: FakeGitHub, argv: string[]) {
	m = machine();
	m.writeConfig({
		tracker: { type: 'github' },
		codeHost: { type: 'github' },
		check: 'make check',
		allowedCommands: ['make check']
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

	it('runs no machine check', async () => {
		const github = feature([GOOD]);
		expect(await doctor(github, ['doctor', '1', '--use-api-key'])).toBe(0);
		expect(out.join('\n')).not.toMatch(/claude|Node|git signing/);
	});
});
