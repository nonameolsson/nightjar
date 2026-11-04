import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CheckResult } from './check.js';
import type { StepOutcome, StepRequest } from './coding-agent.js';
import { memorySpend } from './fakes/spend.js';
import type { Env } from './git.js';
import type { Ticket } from './tracker.js';
import {
	chooseWorkflow,
	openWorkflow,
	skillsNamed,
	workflowLine,
	type FixEnd,
	type FixWork,
	type StepConfig,
	type StepLog,
	type StepsRun,
	type StepsTree,
	type WorkflowConfig
} from './workflow.js';

const flow: WorkflowConfig = {
	steps: [{ name: 'critique', prompt: 'look', point: 'afterAllTickets' }]
};

describe('workflowLine', () => {
	it.each([
		['**Workflow:** design-review', 'design-review'],
		['Workflow: design-review', 'design-review'],
		['text\n\n**workflow:**  `design-review`  \nmore', 'design-review'],
		['**Workflow:** two words', 'two words']
	])('reads %j', (body, name) => {
		expect(workflowLine(body)).toBe(name);
	});

	it('finds none in a body without the line', () => {
		expect(workflowLine('A Feature about the Workflow: it is long')).toBeUndefined();
		expect(workflowLine('**Workflow:**')).toBeUndefined();
	});
});

describe('chooseWorkflow', () => {
	const settings = { workflows: { 'design-review': flow } };

	it('picks none without a line or a default', () => {
		expect(chooseWorkflow(settings, 'a body')).toEqual({ kind: 'none' });
		expect(chooseWorkflow({}, 'a body')).toEqual({ kind: 'none' });
	});

	it('picks the default without a line, and the line over the default', () => {
		const withDefault = {
			workflows: { ...settings.workflows, other: flow },
			defaultWorkflow: 'other'
		};
		expect(chooseWorkflow(withDefault, 'a body')).toMatchObject({ name: 'other' });
		expect(chooseWorkflow(withDefault, '**Workflow:** design-review')).toMatchObject({
			name: 'design-review'
		});
	});

	it('refuses an unknown name, naming the known ones', () => {
		const got = chooseWorkflow(settings, '**Workflow:** nope');
		expect(got).toMatchObject({ kind: 'refused' });
		expect(got.kind === 'refused' && got.why).toContain('`design-review`');
	});

	it('refuses a line when factory.json names no Workflow', () => {
		const got = chooseWorkflow({}, '**Workflow:** nope');
		expect(got.kind === 'refused' && got.why).toContain('factory.json names none');
	});

	it('finds a Workflow whatever the case of its name', () => {
		expect(chooseWorkflow(settings, '**Workflow:** Design-Review')).toMatchObject({
			kind: 'workflow',
			name: 'design-review'
		});
	});

	it('refuses a Workflow that cannot run here, with the reason', () => {
		const got = chooseWorkflow(
			{ ...settings, brokenWorkflows: { 'design-review': 'no such skill' } },
			'**Workflow:** design-review'
		);
		expect(got.kind === 'refused' && got.why).toContain('no such skill');
	});
});

describe('skillsNamed', () => {
	it('finds the skills a prompt names with a slash', () => {
		expect(skillsNamed('/design-critic critique, then /tdd')).toEqual(['design-critic', 'tdd']);
		expect(skillsNamed('Run `/plugin:skill` once')).toEqual(['plugin:skill']);
	});

	it('does not read a path or a URL as a skill', () => {
		expect(skillsNamed('edit src/app/main.ts and /tmp/notes, see https://a.example/x')).toEqual([]);
		expect(skillsNamed('about 1/2 of it')).toEqual([]);
	});
});

// The Steps of a Workflow over an in-memory worktree, a scripted Coding agent and scripted fix rounds.
describe('the Steps of a Workflow', () => {
	const FOLDER = '/worktrees/1-one-escape';
	const NOTES = `${FOLDER}/.factory/notes`;
	const ENV: Env = { PATH: '/bin' };
	const PORTS = { WEB_PORT: '4500', DB_PORT: '4501' };
	const feature = { id: '1', title: 'One escape', body: '**Workflow:** w' };
	const ticket = (id: string): Ticket => ({
		id,
		title: `Ticket ${id}`,
		body: '',
		open: true,
		signals: ['ready'],
		blockedBy: []
	});

	const critique = { name: 'critique', prompt: '/critique', point: 'afterAllTickets' } as const;
	const polish = { name: 'polish', prompt: '/polish', point: 'afterAllTickets' } as const;
	const lint = { name: 'lint', prompt: 'lint it', point: 'afterEachTicket' } as const;
	const tidy = (maxRounds: number, over: Partial<StepConfig> = {}): StepConfig => ({
		name: 'tidy',
		prompt: 'tidy the code',
		point: 'afterAllTickets',
		until: 'no lint warnings remain',
		maxRounds,
		...over
	});

	const stepDone = (
		req: StepRequest,
		over: Partial<Extract<StepOutcome, { kind: 'done' }>> = {}
	): StepOutcome => ({
		kind: 'done',
		summary: 'did it',
		left: [],
		untilHolds: true,
		sessionId: req.sessionId,
		costUsd: 1,
		...over
	});

	interface Bench {
		readonly asked: StepRequest[];
		readonly fixes: FixWork[];
		readonly checks: { readonly command: string; readonly cwd: string; readonly env: Env }[];
		readonly logged: StepLog[];
		readonly said: string[];
		readonly shown: { ticket: string | null; session: string; round: number; rounds: number }[];
		readonly commits: Parameters<StepsTree['commitStep']>[0][];
		readonly reverts: string[];
		readonly serves: {
			readonly command: string;
			readonly cwd: string;
			readonly port: number | null;
		}[];
		stopped: number;
		serveOk: boolean;
		checkOk: boolean;
		// the Steps the branch holds already
		done: string[];
		agent: (req: StepRequest) => StepOutcome;
		// the fix rounds; the default runs none and leaves the check as it is
		fixer: (work: FixWork) => FixEnd;
		dailyPause: string | null;
		aborted: boolean;
	}

	const bench = (): Bench => ({
		asked: [],
		fixes: [],
		checks: [],
		logged: [],
		said: [],
		shown: [],
		commits: [],
		reverts: [],
		serves: [],
		stopped: 0,
		serveOk: true,
		checkOk: true,
		done: [],
		agent: (req) => stepDone(req),
		fixer: (work) => ({ check: work.check, spent: work.spent, summaries: [] }),
		dailyPause: null,
		aborted: false
	});

	const open = (b: Bench, workflow: WorkflowConfig, over: Partial<StepsRun['setup']> = {}) => {
		let id = 0;
		const tree: StepsTree = {
			at: { branch: 'factory/1-one-escape', folder: FOLDER, base: 'origin/main' },
			// each commit a Step makes moves the head
			head: () => Promise.resolve(`head-${String(b.commits.length)}`),
			notes: () => Promise.resolve(NOTES),
			diff: () => Promise.resolve({ text: '+++ b/ticket-3.txt', truncated: false }),
			stepsDone: () => Promise.resolve(new Set(b.done)),
			commitStep: (o) => {
				b.commits.push(o);
				return Promise.resolve(true);
			},
			revert: (before) => {
				b.reverts.push(before);
				return Promise.resolve();
			}
		};
		const check = (): CheckResult => ({ ok: b.checkOk, tail: 'lint: 1 problem' });
		const run: StepsRun = {
			codingAgent: {
				step: (req) => {
					b.asked.push(req);
					return Promise.resolve(b.agent(req));
				}
			},
			runCheck: (command, cwd, env) => {
				b.checks.push({ command, cwd, env });
				return Promise.resolve(check());
			},
			serve: (command, cwd, _env, port) => {
				b.serves.push({ command, cwd, port });
				if (!b.serveOk) return Promise.resolve({ ok: false, tail: 'port already in use' });
				return Promise.resolve({
					ok: true,
					stop: () => {
						b.stopped += 1;
						return Promise.resolve();
					}
				});
			},
			newId: () => `session-${String((id += 1))}`,
			say: (line) => b.said.push(line),
			setup: { check: 'make check', env: ENV, limits: { ticketUsd: 15 }, ...over },
			feature,
			tree,
			fix: (work) => {
				b.fixes.push(work);
				return Promise.resolve(b.fixer(work));
			},
			log: (entry) => b.logged.push(entry),
			building: (t, session, rounds) => b.shown.push({ ticket: t, session, ...rounds }),
			dailyPause: () => b.dailyPause,
			allowance: (cap, spent) => memorySpend().allowance(cap, spent),
			aborted: () => b.aborted
		};
		return openWorkflow({ name: 'w', workflow }, run);
	};

	const ref = (id: string) => `#${id}`;
	const outcomes = (b: Bench) => b.logged.map((e) => e.outcome);

	it('runs the Steps after all Tickets in order, each in a Session of its own, and commits each', async () => {
		const b = bench();
		const steps = await open(b, { steps: [critique, lint, polish] });
		expect(await steps.runAt('afterAllTickets', null)).toEqual({ kind: 'next' });

		const [first, second, ...more] = b.asked;
		expect(more).toEqual([]);
		expect(first).toEqual({
			kind: 'step',
			at: { branch: 'factory/1-one-escape', folder: FOLDER, base: 'origin/main' },
			sessionId: 'session-1',
			workflow: 'w',
			step: critique,
			extras: {},
			round: 1,
			rounds: 1,
			feature,
			ticket: null,
			notes: NOTES,
			// the Feature's diff, so the agent picks its own targets
			diff: { text: '+++ b/ticket-3.txt', truncated: false },
			left: [],
			budgetUsd: 15
		});
		expect(second).toMatchObject({ sessionId: 'session-2', step: polish });
		expect(b.checks).toEqual([
			{ command: 'make check', cwd: FOLDER, env: ENV },
			{ command: 'make check', cwd: FOLDER, env: ENV }
		]);
		expect(b.commits).toEqual([
			{
				workflow: 'w',
				step: 'critique',
				key: 'w/critique',
				after: null,
				summary: 'did it',
				session: 'session-1'
			},
			expect.objectContaining({ key: 'w/polish', session: 'session-2' })
		]);
		expect(b.reverts).toEqual([]);
		expect(b.logged).toEqual([
			{
				ticket: null,
				step: 'step',
				session: 'session-1',
				costUsd: 1,
				outcome: 'w/critique: round 1'
			},
			{
				ticket: null,
				step: 'step',
				session: 'session-2',
				costUsd: 1,
				outcome: 'w/polish: round 1'
			}
		]);
		expect(b.shown).toEqual([
			{ ticket: null, session: 'session-1', round: 1, rounds: 1 },
			{ ticket: null, session: 'session-2', round: 1, rounds: 1 }
		]);
		expect(b.said).toEqual(['w/critique: session session-1', 'w/polish: session session-2']);
		const section = steps.section([], ref);
		expect(section).toBe('## Workflow `w`\n\n- `critique`: done\n- `polish`: done');
	});

	it('runs an afterEachTicket Step after its Ticket, without the Feature diff, and keys it by the Ticket', async () => {
		const b = bench();
		const steps = await open(b, { steps: [critique, lint] });
		await steps.runAt('afterEachTicket', ticket('2'));

		expect(b.asked).toHaveLength(1);
		expect(b.asked[0]).toMatchObject({ step: lint, ticket: { id: '2' } });
		expect(b.asked[0]?.diff).toBeUndefined();
		expect(b.commits.map((c) => [c.key, c.after])).toEqual([['w/lint #2', '2']]);
		expect(b.logged.map((e) => e.ticket)).toEqual(['2']);
		expect(b.shown[0]?.ticket).toBe('2');
		expect(steps.reports(['2', '3']).map((r) => [r.step.name, r.ticket, r.state])).toEqual([
			['critique', null, 'undone'],
			['lint', '2', 'done']
		]);
	});

	it('starts nothing at a point with no Step to run', async () => {
		const b = bench();
		const steps = await open(b, { steps: [critique], serve: 'npm run dev' });
		expect(await steps.runAt('afterEachTicket', ticket('2'))).toEqual({ kind: 'next' });
		expect(b.asked).toEqual([]);
		expect(b.serves).toEqual([]);
	});

	it.each([
		['blocked', 'it reported itself blocked: which palette?', 'w/critique: blocked'],
		['failed', 'it reached its budget', 'w/critique: failed: it reached its budget'],
		['red', 'its changes leave the check failing', 'w/critique: round 1']
	] as const)(
		'throws a Step away that is %s, runs the next one, and reports it not done',
		async (act, why, outcome) => {
			const b = bench();
			b.agent = (req) => {
				b.checkOk = req.step.name !== 'critique' || act !== 'red';
				const { sessionId } = req;
				if (req.step.name === 'critique' && act === 'blocked')
					return { kind: 'blocked', blocker: 'which palette?', sessionId, costUsd: 1 };
				if (req.step.name === 'critique' && act === 'failed')
					return { kind: 'failed', why, failure: 'budget', sessionId, costUsd: 15.2 };
				return stepDone(req);
			};
			const steps = await open(b, { steps: [critique, polish] });
			expect(await steps.runAt('afterAllTickets', null)).toEqual({ kind: 'next' });

			expect(b.reverts).toEqual(['head-0']);
			expect(b.commits.map((c) => c.key)).toEqual(['w/polish']);
			expect(outcomes(b)[0]).toBe(outcome);
			expect(b.said).toContain(`w/critique: not done, ${why}`);
			expect(steps.section([], ref)).toBe(
				`## Workflow \`w\`\n\n- \`critique\`: **not done**, ${why}; its changes were thrown away\n- \`polish\`: done`
			);
		}
	);

	it('runs a Step again in its own Session until its condition holds, and lists what is left when it never does', async () => {
		const b = bench();
		b.agent = (req) => stepDone(req, { untilHolds: false, left: ['a.ts: unused import'] });
		const steps = await open(b, { steps: [tidy(2)] });
		await steps.runAt('afterAllTickets', null);

		expect(b.asked.map((s) => [s.sessionId, s.round, s.rounds, s.left])).toEqual([
			['session-1', 1, 2, []],
			['session-1', 2, 2, ['a.ts: unused import']]
		]);
		expect(b.commits.map((c) => [c.key, c.summary])).toEqual([['w/tidy', 'did it\n\ndid it']]);
		expect(outcomes(b)).toEqual(['w/tidy: round 1', 'w/tidy: round 2']);
		expect(steps.reports([])).toMatchObject([
			{ state: 'unmet', rounds: 2, left: ['a.ts: unused import'] }
		]);
		expect(steps.section([], ref)).toContain(
			'did not hold after 2 rounds. Left:\n  - a.ts: unused import'
		);
	});

	it('stops a Step when its condition holds, before maxRounds', async () => {
		const b = bench();
		b.agent = (req) => stepDone(req, { untilHolds: req.round > 1 });
		const steps = await open(b, { steps: [tidy(3)] });
		await steps.runAt('afterAllTickets', null);
		expect(b.asked).toHaveLength(2);
		expect(steps.section([], ref)).toContain('- `tidy`: done');
	});

	it('runs a Step on its own budget, each round on what is left, until less than a dollar is', async () => {
		const b = bench();
		b.agent = (req) => stepDone(req, { untilHolds: false, costUsd: 1.5 });
		const steps = await open(b, { steps: [tidy(5, { budgetUsd: 4 })] });
		await steps.runAt('afterAllTickets', null);
		expect(b.asked.map((s) => s.budgetUsd)).toEqual([4, 2.5, 1]);
		expect(b.fixes.map((f) => [f.cap, f.spent])).toEqual([
			[4, 1.5],
			[4, 3],
			[4, 4.5]
		]);
		expect(steps.reports([])).toMatchObject([{ state: 'unmet', rounds: 3 }]);
	});

	it("gives a Step and its fix rounds the Workflow's commands, tools and localhost network", async () => {
		const b = bench();
		const extras = {
			allowedCommands: ['npm run e2e'],
			allowedTools: ['mcp__browser__*'],
			localNetwork: true
		};
		b.checkOk = false;
		b.fixer = (work) => ({
			check: { ok: true, tail: '' },
			spent: work.spent + 1,
			summaries: ['fixed the lint']
		});
		const steps = await open(b, { steps: [critique], ...extras });
		await steps.runAt('afterAllTickets', null);

		expect(b.asked[0]?.extras).toEqual(extras);
		expect(b.fixes).toEqual([
			{
				ticket: null,
				name: 'w/critique',
				sessionId: 'session-1',
				cap: 15,
				spent: 1,
				check: { ok: false, tail: 'lint: 1 problem' },
				of: { kind: 'step', step: critique, extras }
			}
		]);
		expect(b.commits[0]?.summary).toBe('did it\n\nfixed the lint');
	});

	it('serves on the first reserved port while its Steps run, and stops it after', async () => {
		const b = bench();
		const steps = await open(
			b,
			{ steps: [critique, polish], serve: 'npm run dev' },
			{ portEnv: PORTS }
		);
		await steps.runAt('afterAllTickets', null);
		expect(b.serves).toEqual([{ command: 'npm run dev', cwd: FOLDER, port: 4500 }]);
		expect(b.stopped).toBe(1);
		expect(b.said[0]).toBe('#1: serving npm run dev');
		expect(b.checks[0]?.env).toEqual({ ...ENV, ...PORTS });
	});

	it('reports every Step not done when the serve command fails to start, and starts no Session', async () => {
		const b = bench();
		b.serveOk = false;
		const steps = await open(b, { steps: [critique, polish], serve: 'npm run dev' });
		expect(await steps.runAt('afterAllTickets', null)).toEqual({ kind: 'next' });
		expect(b.asked).toEqual([]);
		expect(b.stopped).toBe(0);
		expect(steps.reports([]).map((r) => [r.step.name, r.state, r.why])).toEqual([
			['critique', 'undone', 'its serve command failed: port already in use'],
			['polish', 'undone', 'its serve command failed: port already in use']
		]);
	});

	const WHY = "the plan's usage limit was reached";
	const ids = (req: StepRequest) => ({ sessionId: req.sessionId, costUsd: 1 });
	it.each([
		{
			name: 'its Session pauses',
			end: { kind: 'paused', why: WHY },
			agent: (req: StepRequest): StepOutcome => ({ kind: 'paused', why: WHY, ...ids(req) }),
			outcome: `w/critique: paused: ${WHY}`
		},
		{
			name: 'a person stops its Session',
			end: { kind: 'aborted' },
			agent: (req: StepRequest): StepOutcome => ({ kind: 'aborted', ...ids(req) }),
			outcome: 'w/critique: stopped by a person'
		},
		{
			name: 'its fix rounds pause',
			end: { kind: 'paused', why: WHY },
			fixer: (work: FixWork): FixEnd => ({
				...work,
				summaries: [],
				halt: { kind: 'paused', why: WHY }
			}),
			outcome: 'w/critique: round 1'
		},
		{
			name: 'a person stops it during its check or fix rounds',
			end: { kind: 'aborted' },
			fixer: (work: FixWork): FixEnd => ({ ...work, summaries: [], halt: { kind: 'aborted' } }),
			outcome: 'w/critique: round 1'
		}
	] as const)(
		"halts the run, reverting the Step's work and running no other, when $name",
		async ({ end, outcome, agent, fixer }) => {
			const b = bench();
			b.agent = agent ?? b.agent;
			b.fixer = fixer ?? b.fixer;
			const steps = await open(b, { steps: [critique, polish] });
			expect(await steps.runAt('afterAllTickets', null)).toEqual(end);

			expect(b.reverts).toEqual(['head-0']);
			expect(b.commits).toEqual([]);
			expect(b.asked.map((s) => s.step.name)).toEqual(['critique']);
			expect(outcomes(b)).toEqual([outcome]);
		}
	);

	it('pauses before a Step once the day has spent its limit, and halts when a person stopped the run', async () => {
		const b = bench();
		b.dailyPause = 'the daily limit';
		const steps = await open(b, { steps: [critique] });
		expect(await steps.runAt('afterAllTickets', null)).toEqual({
			kind: 'paused',
			why: 'the daily limit'
		});
		b.dailyPause = null;
		b.aborted = true;
		expect(await steps.runAt('afterAllTickets', null)).toEqual({ kind: 'aborted' });
		expect(b.asked).toEqual([]);
	});

	it('runs no Step the branch holds already, and reports it done', async () => {
		const b = bench();
		b.done = ['w/critique', 'w/lint #2'];
		const steps = await open(b, { steps: [critique, lint, polish] });
		await steps.runAt('afterEachTicket', ticket('2'));
		await steps.runAt('afterAllTickets', null);

		expect(b.asked.map((s) => s.step.name)).toEqual(['polish']);
		expect(steps.section(['2'], ref)).toBe(
			'## Workflow `w`\n\n- `critique`: done\n- `lint` (after #2): done\n- `polish`: done'
		);
	});

	it('lists the Steps after all Tickets as not run while the Feature is not complete', async () => {
		const b = bench();
		const steps = await open(b, { steps: [lint, critique] });
		await steps.runAt('afterEachTicket', ticket('2'));
		expect(steps.section(['2'], ref)).toBe(
			'## Workflow `w`\n\n- `lint` (after #2): done\n- `critique`: **not done**, it did not run, as the Feature is not complete; its changes were thrown away'
		);
	});

	it('has no section when no Step ran or is waiting', async () => {
		const steps = await open(bench(), { steps: [lint] });
		expect(steps.section([], ref)).toBeNull();
	});
});

describe('the code', () => {
	it('names no skill: a Workflow brings its own', () => {
		const root = fileURLToPath(new URL('..', import.meta.url));
		const name = new RegExp(['impe', 'ccable'].join(''), 'i');
		const found = globSync('src/**/*.ts', { cwd: root }).filter((f) =>
			name.test(readFileSync(join(root, f), 'utf8'))
		);
		expect(found).toEqual([]);
	});
});
