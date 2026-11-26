// The build loop over the in-memory Tracker, Code host and worktree, and a scripted Coding agent; the few specs about commits, discards and cleanup run over real git.
import { execFileSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildFeature,
	featureOfBody,
	fixPullChecks,
	handedOver,
	LIMITS,
	pullFixLimits,
	type Deps,
	type Setup
} from './build.js';
import { dryRun, feedbackPass, pullChecksPass, queue, type QueueDeps } from './queue.js';
import type {
	BuildOutcome,
	BuildRequest,
	Ended,
	FeedbackOutcome,
	FeedbackRequest,
	FixOutcome,
	FixRequest,
	ReviewOutcome,
	ReviewRequest,
	ReviewRoundOutcome,
	ReviewRoundRequest,
	StepOutcome,
	StepRequest
} from './coding-agent.js';
import type { Env } from './git.js';
import type { Feedback, Pull } from './code-host.js';
import { FakeCodeHost } from './fakes/code-host.js';
import { FOOTER } from './footer.js';
import { memoryLogbook, type MemoryLogbook } from './fakes/logbook.js';
import { memorySpend } from './fakes/spend.js';
import { FakeTracker } from './fakes/tracker.js';
import { memoryWorktrees, type MemoryWorktrees } from './fakes/worktree.js';
import { featureAfterRunStep, nextStepText, noteStep, ticketStep } from './next-step.js';
import { QUESTIONS_MARK, type Review } from './prompt.js';
import { markPublished, publishMarkOf, publishedByNightjar } from './publish.js';
import type { Spend } from './spend.js';
import type { WorkflowConfig } from './workflow.js';
import type { Served } from './serve.js';
import type { Doing, Happened } from './status.js';
import { DEFAULT_SIGNAL_NAMES, type Signal } from './signals.js';
import { attemptBranch, openWorktree, type OpenWorktree } from './worktree.js';
import type { LogbookEntry } from './logbook.js';
import { baseLine, botPullMarker } from './base-line.js';

// A test over real git runs a few dozen processes, which take seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

// What the scripted agent does with each Ticket's build, by the Ticket's id.
// 'flaky' fails for a passing reason `flaky` times, leaving a file, and then builds; 'down' does so every time; 'empty' says it built but writes no file
type Act = 'build' | 'ask' | 'fail' | 'flaky' | 'down' | 'lasting' | 'lasting-other' | 'empty';

// One piece of work the build loop asked the Coding agent for.
type Work =
	BuildRequest | FixRequest | StepRequest | FeedbackRequest | ReviewRequest | ReviewRoundRequest;

// How any kind of work can end besides its answer.
type Ending = Ended & { readonly sessionId: string; readonly costUsd: number };

interface World {
	// whether its worktrees are real git; if not they are in memory, in `trees`
	readonly git: boolean;
	readonly trees: MemoryWorktrees;
	readonly root: string;
	// where its worktrees are made
	readonly worktrees: string;
	readonly env: Record<string, string | undefined>;
	readonly tracker: FakeTracker;
	readonly host: FakeCodeHost;
	// what the loop records, in place of .factory/runs.jsonl
	readonly spend: Spend;
	// what the loop writes, in place of .factory/logbook/
	readonly logbook: MemoryLogbook;
	readonly asked: Work[];
	// each check command run, with the folder it ran in
	readonly checks: { readonly command: string; readonly cwd: string }[];
	// the environment each check ran with
	readonly checkEnvs: Env[];
	readonly setups: { readonly command: string; readonly cwd: string; readonly env: Env }[];
	// each serve command started, and how many have been stopped
	readonly serves: {
		readonly command: string;
		readonly cwd: string;
		readonly port: number | null;
	}[];
	stopped: number;
	serveOk: boolean;
	// what the scripted agent does in a Workflow Step; the default builds nothing and holds
	stepAgent: (req: StepRequest) => StepOutcome;
	// what the scripted agent does in a fix round; the default says it fixed it
	fixAgent: (req: FixRequest) => FixOutcome;
	// what the scripted agent does in a Feedback round; the default changes a file and answers every piece
	feedbackAgent: (req: FeedbackRequest) => FeedbackOutcome;
	// what the scripted agent's Review says; the default approves with a nit
	reviewAgent: (req: ReviewRequest) => ReviewOutcome;
	// what the scripted agent does in a Review round; the default changes a file and says it fixed the issues
	reviewRoundAgent: (req: ReviewRoundRequest) => ReviewRoundOutcome;
	// whether a Review round leaves a changed file; the default does
	reviewRoundWrites: boolean;
	acts: Record<string, Act>;
	// how many passing failures a 'flaky' Ticket has before it builds
	flaky: number;
	// the waits the loop asked for between tries
	readonly waits: number[];
	// the tries each Ticket's build has had
	readonly tries: Record<string, number>;
	// the test the scripted agent says shows a Ticket's bug, by Ticket
	tests: Record<string, string>;
	// an end to give a piece of work in place of the scripted agent's answer
	settle: (req: Work) => Ending | undefined;
	checkOk: boolean;
	setupOk: boolean;
	// the Sessions this machine has not got, as a Session made on another machine is
	readonly goneSessions: Set<string>;
	// what the loop told .factory/status.json, in order
	readonly doing: Doing[];
	readonly happened: Happened[];
}

let base: string;
let template: string | undefined;

// git starts gc and maintenance detached, and they can still be writing when afterEach removes the folder.
const GITCONFIG = '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n';

const gitEnv = (config: string) => ({
	...process.env,
	GIT_CONFIG_GLOBAL: config,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.com'
});

// Made once, on the first world that wants real git, and copied per test: real git is the slow part.
function templateRepo(): string {
	if (template !== undefined) return template;
	const dir = mkdtempSync(join(tmpdir(), 'nightjar-build-template-'));
	const config = join(dir, 'gitconfig');
	writeFileSync(config, GITCONFIG);
	const origin = join(dir, 'origin.git');
	const app = join(dir, 'app');
	const sh = (...args: string[]) =>
		execFileSync('git', args, { env: gitEnv(config), stdio: 'pipe' });
	sh('init', '-q', '--bare', '-b', 'main', origin);
	sh('clone', '-q', origin, app);
	writeFileSync(join(app, 'README.md'), 'hello\n');
	sh('-C', app, 'add', '.');
	sh('-C', app, 'commit', '-q', '-m', 'first');
	sh('-C', app, 'push', '-q', 'origin', 'main');
	template = dir;
	return dir;
}
afterAll(() => {
	if (template !== undefined) rmSync(template, { recursive: true, force: true });
});

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), 'nightjar-build-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

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

// A Feedback round's answer that answers every piece it was given, at a cost of $2.
const answerAll = (req: FeedbackRequest): FeedbackOutcome => ({
	kind: 'answered',
	summary: 'Answered the review.',
	items: req.feedback.map((f) => ({ id: f.id, answered: true, note: `Changed it for ${f.id}.` })),
	sessionId: req.sessionId,
	costUsd: 2
});

// The Review's verdict, at a cost of $0.50.
const reviewed = (
	req: ReviewRequest,
	verdict: 'approve' | 'changes',
	issues: Review['issues'] = [{ file: 'a.ts', line: 2, problem: 'nit' }]
): ReviewOutcome => ({
	kind: 'reviewed',
	review: {
		verdict,
		summary: verdict === 'approve' ? 'Reads well.' : 'One bug.',
		issues
	},
	sessionId: req.sessionId,
	costUsd: 0.5
});

// A world whose worktrees are in memory: no git, so no folder either.
const makeWorld = (): World => worldOf({ git: false, root: join(base, 'app'), env: {} });

// A world over real git, for the specs about commits, discards and cleanup. A second one in a test needs a folder of its own: git's object files are read-only, so they cannot be copied over the first's.
function makeGitWorld(dir = base): World {
	if (existsSync(join(dir, 'origin.git'))) {
		throw new Error(`makeGitWorld: ${dir} holds a world already; pass another folder`);
	}
	mkdirSync(dir, { recursive: true });
	const home = join(dir, 'gitconfig');
	writeFileSync(home, GITCONFIG);
	const env = gitEnv(home);
	const origin = join(dir, 'origin.git');
	const root = join(dir, 'app');
	cpSync(join(templateRepo(), 'origin.git'), origin, { recursive: true });
	cpSync(join(templateRepo(), 'app'), root, { recursive: true });
	execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', origin], { env, stdio: 'pipe' });
	return worldOf({ git: true, root, env, dir });
}

function worldOf(o: {
	git: boolean;
	root: string;
	env: Record<string, string | undefined>;
	dir?: string;
}): World {
	const { root, env } = o;
	const dir = o.dir ?? base;
	const tracker = new FakeTracker('ann', () => new Date(2026, 9, 30, 8));
	// the Feature lists 3 first, but 3 waits for 2
	tracker.add({
		id: '1',
		title: 'One escape',
		assignees: ['ann'],
		signals: ['go'],
		children: ['3', '2']
	});
	tracker.add({ id: '2', title: 'Share the function', signals: ['ready'] });
	tracker.add({ id: '3', title: 'Use it in marks', signals: ['ready'], blockedBy: ['2'] });
	const host = new FakeCodeHost();
	// the branch here fetches what the Code host holds
	const trees = memoryWorktrees((branch) => host.branchMessages(branch));
	// a push brings the branch's commits to the Code host, oldest first
	host.commitsAt = (folder) => [...trees.messages(folder)].reverse();
	return {
		git: o.git,
		trees,
		root,
		worktrees: join(dir, 'worktrees'),
		env,
		tracker,
		host,
		spend: memorySpend(),
		logbook: memoryLogbook(),
		asked: [],
		checks: [],
		checkEnvs: [],
		setups: [],
		serves: [],
		stopped: 0,
		serveOk: true,
		stepAgent: (req) => stepDone(req),
		fixAgent: (req) => ({ kind: 'fixed', summary: 'fixed', sessionId: req.resume, costUsd: 1 }),
		feedbackAgent: (req) => answerAll(req),
		reviewAgent: (req) => reviewed(req, 'approve'),
		reviewRoundAgent: (req) => ({
			kind: 'fixed',
			summary: 'Fixed what the Review found.',
			declined: [],
			sessionId: req.sessionId,
			costUsd: 2
		}),
		reviewRoundWrites: true,
		acts: {},
		flaky: 1,
		waits: [],
		tries: {},
		tests: {},
		settle: () => undefined,
		checkOk: true,
		setupOk: true,
		goneSessions: new Set(),
		doing: [],
		happened: []
	};
}

const askedOf = <K extends Work['kind']>(world: World, kind: K) =>
	world.asked.filter((r): r is Extract<Work, { kind: K }> => r.kind === kind);

function deps(world: World): Deps {
	let id = 0;
	const answer = <T>(req: Work, got: () => T): Promise<T | Ending> => {
		world.asked.push(req);
		return Promise.resolve(world.settle(req) ?? got());
	};
	return {
		tracker: world.tracker,
		codeHost: world.host,
		codingAgent: {
			build: (req) =>
				answer(req, (): BuildOutcome => {
					const n = req.ticket.id;
					const act = world.acts[n] ?? 'build';
					// a note's Session may write only its note
					const file = req.output === 'note' ? `docs/research/${n}.md` : `ticket-${n}.txt`;
					if (act !== 'empty') write(world, req.at.folder, file);
					const { sessionId } = req;
					if (act === 'ask') {
						const questions = [{ question: 'Which file?', recommendation: 'marks.ts' }];
						return { kind: 'questions', questions, sessionId, costUsd: 2 };
					}
					if (act === 'flaky' || act === 'down') {
						const tried = (world.tries[n] = (world.tries[n] ?? 0) + 1);
						if (act === 'down' || tried <= world.flaky) {
							write(world, req.at.folder, 'half-done.txt');
							return {
								kind: 'failed',
								why: `claude exited with code 1 and no result: overloaded, try ${String(tried)}`,
								failure: 'passing',
								sessionId,
								costUsd: 1
							};
						}
					}
					if (act === 'lasting' || act === 'lasting-other') {
						return {
							kind: 'failed',
							why: act === 'lasting' ? 'the login is rejected' : 'the disk is full',
							failure: 'lasting',
							sessionId,
							costUsd: 1
						};
					}
					if (act === 'fail') {
						return {
							kind: 'failed',
							why: 'it reached its budget',
							failure: 'budget',
							sessionId,
							costUsd: 15.2
						};
					}
					const test = world.tests[n];
					return {
						kind: 'built',
						summary: `Built #${n}`,
						...(test === undefined ? {} : { test }),
						sessionId,
						costUsd: 3
					};
				}),
			fix: (req) => answer(req, () => world.fixAgent(req)),
			step: (req) => answer(req, () => world.stepAgent(req)),
			feedback: (req) =>
				answer(req, () => {
					write(world, req.at.folder, `feedback-${req.sessionId}.txt`);
					return world.feedbackAgent(req);
				}),
			review: (req) => answer(req, () => world.reviewAgent(req)),
			reviewRound: (req) =>
				answer(req, () => {
					if (world.reviewRoundWrites) write(world, req.at.folder, `review-${req.sessionId}.txt`);
					return world.reviewRoundAgent(req);
				})
		},
		runCheck: (command, cwd, env) => {
			world.checks.push({ command, cwd });
			world.checkEnvs.push(env);
			const tail = `lint: 1 problem (run ${String(world.checks.length)})`;
			return Promise.resolve({ ok: world.checkOk, tail });
		},
		runSetup: (command, cwd, env) => {
			world.setups.push({ command, cwd, env });
			return Promise.resolve({ ok: world.setupOk, tail: 'deps: registry unreachable' });
		},
		serve: (command, cwd, _env, port): Promise<Served> => {
			world.serves.push({ command, cwd, port });
			if (!world.serveOk) return Promise.resolve({ ok: false, tail: 'port already in use' });
			return Promise.resolve({
				ok: true,
				stop: () => {
					world.stopped += 1;
					return Promise.resolve();
				}
			});
		},
		spend: world.spend,
		logbook: world.logbook,
		openWorktree: world.git ? openWorktree : world.trees.open,
		sleep: (ms) => {
			world.waits.push(ms);
			return Promise.resolve();
		},
		now: () => new Date(2026, 9, 30, 9),
		newId: () => `session-${String((id += 1))}`,
		sessionExists: (sid) => !world.goneSessions.has(sid),
		say: () => undefined,
		status: {
			doing: (d) => world.doing.push(d),
			happened: (h) => world.happened.push(h),
			codeMoved: () => undefined,
			refreshed: () => undefined
		}
	};
}

const setup = (world: World, over: Partial<Setup> = {}): Setup => ({
	root: world.root,
	repo: 'o/r',
	worktrees: world.worktrees,
	baseBranch: 'main',
	check: 'make check',
	allowedCommands: ['make test', 'make lint *'],
	allowApiKey: false,
	env: world.env,
	limits: LIMITS,
	signals: DEFAULT_SIGNAL_NAMES,
	...over
});

const git = (world: World, cwd: string, ...args: string[]) =>
	execFileSync('git', ['-C', cwd, ...args], { env: world.env, encoding: 'utf8' }).trim();

const tree = () => join(base, 'worktrees', '1-one-escape');

// What a scripted Session does in the worktree, and what a spec reads of it, over either adapter.
function write(world: World, folder: string, file: string): void {
	if (world.git) {
		mkdirSync(join(folder, file, '..'), { recursive: true });
		writeFileSync(join(folder, file), 'work\n');
	} else world.trees.write(folder, file);
}

function has(world: World, file: string): boolean {
	return world.git ? existsSync(join(tree(), file)) : world.trees.has(tree(), file);
}

const lines = (text: string) => text.split('\n').filter(Boolean);

// the files a Session left, with nothing committed or thrown away
function left(world: World): string[] {
	if (!world.git) return world.trees.left(tree());
	return lines(git(world, tree(), 'status', '--porcelain'));
}

// the branch's own commits, newest first
function subjects(world: World): string[] {
	if (!world.git) return world.trees.subjects(tree());
	return lines(git(world, tree(), 'log', '--format=%s', 'origin/main..HEAD'));
}

const refs = (world: World) => world.host.pulls[0]?.references.map((r) => r.text);

const ledger = (world: World) => world.spend.entries();

const PORTS = { WEB_PORT: '4500', DB_PORT: '4501' };

describe('the test repo', () => {
	it('makes a second world in a folder of its own', async () => {
		const one = makeGitWorld();
		const two = makeGitWorld(join(base, 'second'));
		await buildFeature(deps(one), setup(one), '1');
		await buildFeature(deps(two), setup(two), '1');
		expect(one.host.pulls).toHaveLength(1);
		expect(two.host.pulls).toHaveLength(1);
	});

	it("says so when a second world would share the first one's folder", () => {
		makeGitWorld();
		expect(() => makeGitWorld()).toThrow('pass another folder');
	});

	it('leaves no detached git maintenance behind to write into the folder after the test', async () => {
		const world = makeGitWorld();
		const trace = join(base, 'trace.jsonl');
		world.env['GIT_TRACE2_EVENT'] = trace;
		await buildFeature(deps(world), setup(world), '1');
		const started = readFileSync(trace, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { event: string; argv?: string[] }).argv ?? []);
		expect(started.filter((argv) => argv.includes('maintenance'))).toEqual([]);
	});
});

describe('worktree setup', () => {
	it('runs the setup command once in a new worktree, before the first session', async () => {
		const world = makeWorld();
		const order: string[] = [];
		const inner = deps(world);
		await buildFeature(
			{
				...inner,
				runSetup: (command, cwd, env) => {
					order.push('setup');
					return inner.runSetup(command, cwd, env);
				},
				codingAgent: {
					...inner.codingAgent,
					build: (req) => {
						order.push('session');
						return inner.codingAgent.build(req);
					}
				}
			},
			setup(world, { setupCommand: 'make deps' }),
			'1'
		);
		expect(world.setups.map((s) => [s.command, s.cwd])).toEqual([['make deps', tree()]]);
		expect(order.slice(0, 2)).toEqual(['setup', 'session']);
	});

	it('does not run it again when a later run goes on in the same worktree', async () => {
		const world = makeWorld();
		world.acts['3'] = 'ask';
		await buildFeature(deps(world), setup(world, { setupCommand: 'make deps' }), '1');
		world.acts['3'] = 'build';
		await world.tracker.addSignal('3', 'ready');
		await world.tracker.addSignal('1', 'go');
		await buildFeature(deps(world), setup(world, { setupCommand: 'make deps' }), '1');
		expect(world.setups).toHaveLength(1);
	});

	it('stops the Feature with a comment saying why when it fails, and runs it again next time', async () => {
		const world = makeWorld();
		world.setupOk = false;
		const got = await buildFeature(deps(world), setup(world, { setupCommand: 'make deps' }), '1');

		expect(got).toMatchObject({ kind: 'nothing' });
		expect(world.asked).toEqual([]);
		expect(world.tracker.signalsOf('1')).toEqual(['needsInfo']);
		expect(world.tracker.said('1')[0]).toContain('`make deps`');
		expect(world.tracker.said('1')[0]).toContain('deps: registry unreachable');
		expect(world.tracker.said('1')[0]).toMatch(/Built by Nightjar\._$/);
		expect(world.happened.at(-1)).toMatchObject({ kind: 'needs-info', feature: '1', ticket: null });
		expect(world.host.pulls).toEqual([]);

		world.setupOk = true;
		await world.tracker.addSignal('1', 'go');
		await buildFeature(deps(world), setup(world, { setupCommand: 'make deps' }), '1');
		expect(world.setups).toHaveLength(2);
		expect(world.host.pulls).toHaveLength(1);
	});

	it('runs nothing when no setup command is set', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		expect(world.setups).toEqual([]);
	});
});

describe('reserved ports', () => {
	it('hands them to the check and the setup command as environment variables', async () => {
		const world = makeWorld();
		world.checkOk = false;
		await buildFeature(
			deps(world),
			setup(world, { portEnv: PORTS, setupCommand: 'make deps' }),
			'1'
		);
		expect(world.setups[0]?.env).toMatchObject(PORTS);
		expect(world.checkEnvs.length).toBeGreaterThan(0);
		for (const e of world.checkEnvs) expect(e).toMatchObject(PORTS);
	});

	it('adds nothing to the environment when none are reserved', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		expect(world.checkEnvs.length).toBeGreaterThan(0);
		for (const e of world.checkEnvs) expect(e).toEqual(world.env);
	});
});

describe('buildFeature', () => {
	it('builds the Tickets in Build order, one commit each, then reviews and opens one draft', async () => {
		const world = makeGitWorld();
		const got = await buildFeature(deps(world), setup(world), '1');

		expect(got).toMatchObject({ kind: 'pull', built: ['2', '3'], waiting: [] });
		expect(subjects(world)).toEqual(['Use it in marks (#3)', 'Share the function (#2)']);
		// pushed through the Code host to the Feature's branch, never to main
		expect(world.host.pushes).toEqual([{ folder: tree(), branch: 'factory/1-one-escape' }]);
		expect(git(world, world.root, 'rev-list', '--count', 'origin/main')).toBe('1');

		expect(world.host.pulls).toHaveLength(1);
		expect(world.host.pulls[0]).toMatchObject({
			head: 'factory/1-one-escape',
			base: 'main',
			title: 'One escape',
			draft: true
		});
		expect(world.host.pulls[0]?.body).toContain('- #2 Share the function\n- #3 Use it in marks');
		expect(refs(world)).toEqual(['#1', '#2', '#3']);
		expect(world.host.pulls[0]?.comments[0]).toContain('**Nightjar review: approve**');
		expect(world.tracker.signalsOf('1')).toEqual([]);

		expect(ledger(world).map((e) => [e.step, e.outcome, e.costUsd])).toEqual([
			['build', 'built', 3],
			['build', 'built', 3],
			['review', 'approve', 0.5]
		]);
	});

	it('builds a lone issue as a Feature of one Ticket: one commit, one draft that closes it, no ready Signal needed', async () => {
		const world = makeWorld();
		world.tracker.add({
			id: '9',
			title: 'Fix the typo',
			body: 'Fix it.\n\n### Acceptance criteria\n\n- [ ] typo gone\n\n**Model:** opus',
			assignees: ['ann'],
			signals: ['go']
		});
		const got = await buildFeature(deps(world), setup(world), '9');

		expect(got).toMatchObject({ kind: 'pull', built: ['9'], waiting: [] });
		expect(world.trees.subjects(join(base, 'worktrees', '9-fix-the-typo'))).toEqual([
			'Fix the typo (#9)'
		]);
		expect(world.host.pulls).toHaveLength(1);
		expect(world.host.pulls[0]).toMatchObject({ head: 'factory/9-fix-the-typo', draft: true });
		expect(refs(world)).toEqual(['#9']);
		expect(askedOf(world, 'build').map((r) => r.ticket.id)).toEqual(['9']);
		expect(world.tracker.signalsOf('9')).not.toContain('go');
		expect(world.tracker.signalsOf('9')).not.toContain('working');
	});

	it('waits for the open blocker of a lone issue and says which one', async () => {
		const world = makeWorld();
		world.tracker.add({
			id: '9',
			title: 'Fix the typo',
			assignees: ['ann'],
			signals: ['go'],
			blockedBy: ['2']
		});
		const got = await buildFeature(deps(world), setup(world), '9');

		expect(got).toMatchObject({ kind: 'nothing' });
		expect(askedOf(world, 'build')).toEqual([]);
		expect(JSON.stringify(got)).toContain('blocked by');
		expect(world.tracker.said('9')[0]).toContain(
			"#9 Fix the typo: blocked by #2, a Ticket outside this Feature: it closes when its Feature's pull request merges. Merge that, then give the Go again."
		);
	});

	it("asks for each Ticket's build in the worktree, with the Tickets built before it and the Ticket's budget", async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		const [two, three, ...more] = askedOf(world, 'build');
		expect(more).toEqual([]);
		const at = { branch: 'factory/1-one-escape', folder: tree() };
		expect(two).toMatchObject({
			at,
			sessionId: 'session-1',
			feature: { id: '1', title: 'One escape' },
			ticket: { id: '2', title: 'Share the function' },
			built: [],
			budgetUsd: LIMITS.ticketUsd
		});
		expect(three).toMatchObject({ at, sessionId: 'session-2', ticket: { id: '3' } });
		expect(three?.built.map((t) => t.id)).toEqual(['2']);
	});

	it('asks for the review of the Tickets built, on the review budget', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		const [review, ...more] = askedOf(world, 'review');
		expect(more).toEqual([]);
		expect(review).toMatchObject({
			at: { folder: tree() },
			sessionId: 'session-3',
			feature: { id: '1' },
			budgetUsd: LIMITS.reviewUsd
		});
		expect(review?.tickets.map((t) => t.id)).toEqual(['2', '3']);
	});

	it('signs its comments and pull request as Nightjar, never as anything else', async () => {
		const world = makeWorld();
		world.acts['3'] = 'ask';
		await buildFeature(deps(world), setup(world), '1');
		const pull = world.host.pulls[0];
		expect(pull?.body).toMatch(/Built by Nightjar\._$/);
		expect(pull?.comments[0]).toMatch(/Built by Nightjar\._$/);
		expect(world.tracker.said('1')[0]).toMatch(/Built by Nightjar\._$/);
		expect(world.tracker.said('3')[0]?.startsWith('<!-- nightjar:questions -->')).toBe(true);
	});

	it('names its Feature in the pull request body, once even after the body is edited', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		expect(featureOfBody(world.host.pulls[0]?.body ?? '')).toBe('1');
		expect(world.host.pulls[0]?.body).toMatchSnapshot();
		await buildFeature(deps(world), setup(world), '1');
		const body = world.host.pulls[0]?.body ?? '';
		expect(body.match(/<!-- nightjar-feature:/g)).toHaveLength(1);
		expect(featureOfBody(body)).toBe('1');
	});

	it('reads no Feature from a body without the marker', () => {
		expect(featureOfBody('Nightjar built all of it.\n\n---\n_Built by Nightjar._')).toBeUndefined();
	});

	it('runs the configured check after each Ticket, in the worktree', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		expect(world.checks).toEqual([
			{ command: 'make check', cwd: tree() },
			{ command: 'make check', cwd: tree() }
		]);
	});

	it('tells the status file each step as it starts, and each Ticket built and the draft opened', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');

		const steps = world.doing.map((d) =>
			d.kind === 'building' ? `${d.step} ${String(d.ticket)} ${String(d.session)}` : d.kind
		);
		// setup again once the Tickets are planned, and each Ticket again when it is built
		expect(steps).toEqual([
			'setup null null',
			'setup null null',
			'build 2 session-1',
			'build 2 session-1',
			'build 3 session-2',
			'build 3 session-2',
			'review null session-3'
		]);
		expect(world.doing[2]).toMatchObject({
			feature: '1',
			title: 'One escape',
			round: 1,
			rounds: 3,
			startedAt: new Date(2026, 9, 30, 9).toISOString()
		});
		expect(world.happened).toEqual([
			{ kind: 'built', feature: '1', ticket: '2' },
			{ kind: 'built', feature: '1', ticket: '3' },
			{
				kind: 'pull',
				feature: '1',
				title: 'One escape',
				url: 'https://code.example/pull/100',
				startedAt: new Date(2026, 9, 30, 9).toISOString(),
				tickets: { built: 2, total: 2 }
			}
		]);
	});

	it('counts the Tickets the branch holds on the pull event, though a later run builds none of them', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		await world.tracker.addSignal('1', 'go');
		await buildFeature(deps(world), setup(world), '1');
		const pulls = world.happened.filter((e) => e.kind === 'pull');
		expect(pulls).toHaveLength(2);
		expect(pulls[1]).toMatchObject({ tickets: { built: 2, total: 2 } });
	});

	it('records how long each session ran in the ledger', async () => {
		const world = makeWorld();
		let minute = 0;
		const now = () => new Date(2026, 9, 30, 9, minute++);
		await buildFeature({ ...deps(world), now }, setup(world), '1');
		const lines = ledger(world);
		expect(lines.map((l) => l.step)).toEqual(['build', 'build', 'review']);
		for (const l of lines) {
			expect(l.durationMs).toBeGreaterThan(0);
			expect((l.durationMs ?? 0) % 60_000).toBe(0);
		}
	});

	it("keeps the Feature's start through every step, while each step starts its own clock", async () => {
		const world = makeWorld();
		let minute = 0;
		const now = () => new Date(2026, 9, 30, 9, minute++);
		await buildFeature({ ...deps(world), now }, setup(world), '1');
		const building = world.doing.flatMap((d) => (d.kind === 'building' ? [d] : []));
		const starts = new Set(building.map((d) => d.featureStartedAt));
		expect(starts).toEqual(new Set([new Date(2026, 9, 30, 9, 0).toISOString()]));
		expect(new Set(building.map((d) => d.startedAt)).size).toBeGreaterThan(1);
	});

	it('tells the status file each Ticket as built, building or waiting, and why it waits', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		const shown = world.doing.map((d) =>
			d.kind === 'building' && d.tickets
				? d.tickets.map((t) => `${t.id} ${t.state}${t.why ? ` (${t.why})` : ''}`).join(', ')
				: '-'
		);
		expect(shown).toEqual([
			'-',
			'3 waiting (blocked by #2), 2 waiting (not reached)',
			'3 waiting (blocked by #2), 2 building',
			'3 waiting (not reached), 2 built',
			'3 building, 2 built',
			'3 built, 2 built',
			'3 built, 2 built'
		]);
		expect(world.doing[1]).toMatchObject({
			tickets: [
				{ id: '3', title: 'Use it in marks' },
				{ id: '2', title: 'Share the function' }
			]
		});
	});

	it('shows a Ticket built on the branch earlier as built, and leaves out one that is closed', async () => {
		const world = makeWorld();
		world.acts['3'] = 'fail';
		await buildFeature(deps(world), setup(world), '1');
		world.doing.length = 0;
		await world.tracker.addSignal('1', 'go');
		world.tracker.add({ id: '9', title: 'Long closed', open: false });
		world.tracker.add({
			id: '1',
			title: 'One escape',
			assignees: ['ann'],
			signals: ['go'],
			children: ['9', '3', '2']
		});
		await buildFeature(deps(world), setup(world), '1');
		const planned = world.doing.find((d) => d.kind === 'building' && d.tickets);
		expect(planned).toMatchObject({
			tickets: [
				{ id: '3', state: 'waiting' },
				{ id: '2', state: 'built' }
			]
		});
	});

	it('hands a Ticket with questions back, skips what it blocks, and builds nothing more', async () => {
		const world = makeWorld();
		world.acts['2'] = 'ask';
		const got = await buildFeature(deps(world), setup(world), '1');

		expect(got).toMatchObject({ kind: 'nothing' });
		expect(world.tracker.said('2')[0]).toMatch(new RegExp(`^${QUESTIONS_MARK}`));
		expect(world.tracker.said('2')[0]).toContain('Which file?\n   - Recommended: marks.ts');
		expect(world.tracker.signalsOf('2')).toEqual(['needsInfo']);
		expect(world.tracker.signalsOf('1')).toEqual(['needsInfo']);
		expect(world.tracker.said('1')[0]).toContain('#3 Use it in marks: blocked by #2');
		// each event carries the Next step its comment gives
		expect(world.happened).toEqual([
			{
				kind: 'needs-info',
				feature: '1',
				ticket: '2',
				why: 'it asked 1 question, round 1',
				next: ticketStep(DEFAULT_SIGNAL_NAMES, 'answer')
			},
			{
				kind: 'needs-info',
				feature: '1',
				ticket: null,
				why: 'it built nothing',
				next: featureAfterRunStep(DEFAULT_SIGNAL_NAMES, { waiting: true, red: false })
			}
		]);
		expect(ledger(world).map((e) => e.outcome)).toEqual(['questions, round 1']);
		// the file the session wrote is gone from the branch
		expect(left(world)).toEqual([]);
		expect(world.host.pulls).toEqual([]);
		expect(world.host.pushes).toEqual([]);
	});

	it('goes on from the branch once the questions are answered, and updates the same draft', async () => {
		const world = makeWorld();
		world.acts['3'] = 'ask';
		await buildFeature(deps(world), setup(world), '1');
		expect(refs(world)).toEqual(['#2']);

		world.acts['3'] = 'build';
		await world.tracker.comment('3', 'Use marks.ts.');
		await world.tracker.addSignal('3', 'ready');
		await world.tracker.addSignal('1', 'go');
		world.asked.length = 0;
		const got = await buildFeature(deps(world), setup(world), '1');

		expect(got).toMatchObject({ kind: 'pull', built: ['2', '3'] });
		const builds = askedOf(world, 'build');
		expect(builds.map((r) => r.ticket.id)).toEqual(['3']);
		expect(builds[0]?.ticketComments.map((c) => c.body)).toContain('Use marks.ts.');
		expect(world.host.pulls).toHaveLength(1);
		expect(world.host.pulls[0]?.body).toContain('Nightjar built all of #1 One escape.');
		expect(refs(world)).toEqual(['#2', '#1', '#3']);
	});

	describe('a draft that conflicts with its base', () => {
		it('gains a Conflicts section naming the base, with no Signal and no Tracker comment', async () => {
			const world = makeWorld();
			world.host.conflictOnOpen = 'yes';
			await buildFeature(deps(world), setup(world, { baseBranch: 'develop' }), '1');

			const body = world.host.pulls[0]?.body ?? '';
			expect(body).toContain('## Conflicts with develop');
			expect(body).toContain('merge or rebase `develop` before review');
			expect(world.tracker.signalsOf('1')).toEqual([]);
			expect(world.tracker.said('1')).toEqual([]);
			expect(world.waits).toEqual([]);
		});

		it('keeps the Conflicts section out of a draft that does not conflict', async () => {
			const world = makeWorld();
			await buildFeature(deps(world), setup(world), '1');
			expect(world.host.pulls[0]?.body).not.toContain('Conflicts with');
		});

		it('asks for about ten seconds while the state is unknown, then leaves the body as it is', async () => {
			const world = makeWorld();
			world.host.conflictOnOpen = 'unknown';
			await buildFeature(deps(world), setup(world), '1');

			expect(world.host.pulls[0]?.body).not.toContain('Conflicts with');
			expect(world.waits.reduce((a, b) => a + b, 0)).toBe(10_000);
			expect(world.host.conflictReads.get(100)).toBe(11);
		});

		it('drops the section of an earlier run once the draft no longer conflicts', async () => {
			const world = makeWorld();
			world.acts['3'] = 'ask';
			world.host.conflictOnOpen = 'yes';
			await buildFeature(deps(world), setup(world), '1');
			expect(world.host.pulls[0]?.body).toContain('## Conflicts with main');

			world.host.setConflict({ id: 100, url: 'https://code.example/pull/100' }, 'no');
			world.acts['3'] = 'build';
			await world.tracker.comment('3', 'Use marks.ts.');
			await world.tracker.addSignal('3', 'ready');
			await world.tracker.addSignal('1', 'go');
			await buildFeature(deps(world), setup(world), '1');

			expect(world.host.pulls).toHaveLength(1);
			expect(world.host.pulls[0]?.body).not.toContain('Conflicts with');
		});

		it('builds on, leaving the body as it is, when the Code host fails to answer', async () => {
			const world = makeWorld();
			world.host.conflicts = () => Promise.reject(new Error('gh could not read pull request #100'));
			const got = await buildFeature(deps(world), setup(world), '1');

			expect(got).toMatchObject({ kind: 'pull' });
			expect(world.host.pulls[0]?.body).not.toContain('Conflicts with');
			expect(refs(world)).toEqual(['#1', '#2', '#3']);
			expect(world.tracker.signalsOf('1')).toEqual([]);
		});

		it('opens a draft as before over a Code host without the method', async () => {
			const world = makeWorld();
			delete (world.host as { conflicts?: unknown }).conflicts;
			const got = await buildFeature(deps(world), setup(world), '1');
			expect(got).toMatchObject({ kind: 'pull' });
			expect(world.host.pulls[0]?.body).not.toContain('Conflicts with');
			expect(world.waits).toEqual([]);
		});
	});

	it('hands back a Ticket with no acceptance criteria before a Session', async () => {
		const world = makeWorld();
		const item = world.tracker.items.get('2');
		if (item) world.tracker.items.set('2', { ...item, body: 'Just do it.' });
		world.asked.length = 0;
		await buildFeature(deps(world), setup(world), '1');

		expect(askedOf(world, 'build').map((r) => r.ticket.id)).not.toContain('2');
		expect(world.tracker.signalsOf('2')).toEqual(['needsInfo']);
		expect(world.tracker.said('2').join('\n')).toContain('Acceptance criteria');
		expect(ledger(world).filter((e) => e.ticket === '2')).toEqual([]);
	});

	it('takes the ready Signal off a Ticket it hands back and lists each fault', async () => {
		const world = makeWorld();
		const item = world.tracker.items.get('2');
		if (item) world.tracker.items.set('2', { ...item, body: '**Model:**\nJust do it.' });
		expect(world.tracker.signalsOf('2')).toContain('ready');
		world.asked.length = 0;
		await buildFeature(deps(world), setup(world), '1');

		expect(world.tracker.signalsOf('2')).not.toContain('ready');
		const said = world.tracker.said('2').join('\n');
		expect(said).toContain('Acceptance criteria');
		expect(said).toContain('**Model:**');
	});

	it('builds a Ticket that passes the check as before', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		expect(askedOf(world, 'build').map((r) => r.ticket.id)).toContain('2');
		expect(world.tracker.signalsOf('2')).not.toContain('needsInfo');
	});

	it('asks a person after the question rounds are used up', async () => {
		const world = makeWorld();
		world.acts['2'] = 'ask';
		world.tracker.say('2', { author: 'ann', body: `${QUESTIONS_MARK}\nround 1`, trusted: true });
		world.tracker.say('2', { author: 'ann', body: `${QUESTIONS_MARK}\nround 2`, trusted: true });
		await buildFeature(deps(world), setup(world), '1');
		expect(world.tracker.signalsOf('2')).toEqual(['human']);
	});

	it('gives a red check its fix rounds, then opens the draft naming the failure and stops', async () => {
		const world = makeWorld();
		world.checkOk = false;
		const got = await buildFeature(deps(world), setup(world), '1');

		const fixes = askedOf(world, 'fix');
		// what is left of the Ticket's budget after the build and each round before
		expect(fixes.map((f) => [f.of.kind, f.resume, f.round, f.tail, f.budgetUsd])).toEqual([
			['build', 'session-1', 1, 'lint: 1 problem (run 1)', 12],
			['build', 'session-1', 2, 'lint: 1 problem (run 2)', 11],
			['build', 'session-1', 3, 'lint: 1 problem (run 3)', 10]
		]);
		expect(world.checks.map((c) => c.command)).toEqual(Array(4).fill('make check'));
		expect(got).toMatchObject({ kind: 'pull', built: ['2'] });
		expect(world.host.pulls[0]?.body).toContain('## The check fails');
		expect(world.host.pulls[0]?.body).toContain('lint: 1 problem (run 4)');
		expect(world.tracker.signalsOf('1')).toEqual(['needsInfo']);
		expect(
			world.doing.flatMap((d) =>
				d.kind === 'building' && d.step === 'fix' ? [`${String(d.round)}/${String(d.rounds)}`] : []
			)
		).toEqual(['1/3', '2/3', '3/3']);
		expect(world.happened.at(-1)).toEqual({
			kind: 'needs-info',
			feature: '1',
			ticket: null,
			why: 'the check fails after #2',
			next: featureAfterRunStep(DEFAULT_SIGNAL_NAMES, { waiting: true, red: true })
		});
	});

	it('ends the fix rounds on one that gave up, and keeps the summaries of the rounds that fixed', async () => {
		const world = makeWorld();
		world.checkOk = false;
		let rounds = 0;
		world.fixAgent = (req) =>
			(rounds += 1) === 1
				? { kind: 'fixed', summary: 'Fixed the lint', sessionId: req.resume, costUsd: 1 }
				: { kind: 'gaveUp', sessionId: req.resume, costUsd: 1 };
		await buildFeature(deps(world), setup(world), '1');

		expect(askedOf(world, 'fix')).toHaveLength(2);
		expect(ledger(world).map((e) => [e.step, e.outcome])).toEqual([
			['build', 'built'],
			['fix', 'round 1'],
			['fix', 'round 2 gave up'],
			['review', 'approve']
		]);
		expect(world.trees.messages(tree())[0]).toContain('Built #2\n\nFixed the lint');
	});

	it('tries a build again after a passing failure, from the commit before it, and builds the Ticket', async () => {
		const world = makeWorld();
		world.acts['2'] = 'flaky';
		await buildFeature(deps(world), setup(world), '1');
		expect(world.waits).toEqual([30_000]);
		expect(world.trees.has(tree(), 'half-done.txt')).toBe(false);
		expect(world.trees.has(tree(), 'ticket-2.txt')).toBe(true);
		expect(
			ledger(world)
				.filter((e) => e.step === 'build' && e.ticket === '2')
				.map((e) => [e.outcome.slice(0, 21), e.failure])
		).toEqual([
			['failed: claude exited', 'passing'],
			['built', undefined]
		]);
		expect(world.tracker.said('2')).toEqual([]);
	});

	it('tries a fix round again after a passing failure, from what the build left', async () => {
		const world = makeWorld();
		world.checkOk = false;
		let rounds = 0;
		world.fixAgent = (req) => {
			rounds += 1;
			if (rounds === 1) {
				write(world, req.at.folder, 'half-fixed.txt');
				return {
					kind: 'failed',
					why: 'claude exited with code 1 and no result: overloaded',
					failure: 'passing',
					sessionId: req.resume,
					costUsd: 1
				};
			}
			world.checkOk = true;
			return { kind: 'fixed', summary: 'fixed', sessionId: req.resume, costUsd: 1 };
		};
		await buildFeature(deps(world), setup(world), '1');
		expect(world.waits).toEqual([30_000]);
		expect(has(world, 'half-fixed.txt')).toBe(false);
		expect(has(world, 'ticket-2.txt')).toBe(true);
		expect(
			ledger(world)
				.filter((e) => e.step === 'fix')
				.map((e) => [e.outcome.slice(0, 7), e.failure])
		).toEqual([
			['failed:', 'passing'],
			['round 1', undefined]
		]);
	});

	it('tries the review again after a passing failure', async () => {
		const world = makeWorld();
		let reviews = 0;
		world.settle = (req) =>
			req.kind === 'review' && (reviews += 1) === 1
				? {
						kind: 'failed',
						why: 'claude could not start: spawn claude ENOENT',
						failure: 'passing',
						sessionId: req.sessionId,
						costUsd: 0
					}
				: undefined;
		await buildFeature(deps(world), setup(world), '1');
		expect(world.waits).toEqual([30_000]);
		expect(askedOf(world, 'review')).toHaveLength(2);
		expect(ledger(world).filter((e) => e.step === 'review')).toMatchObject([
			{ failure: 'passing' },
			{ outcome: 'approve' }
		]);
	});

	it('hands a Ticket back after three passing failures, naming all three', async () => {
		const world = makeWorld();
		world.acts['2'] = 'down';
		await buildFeature(deps(world), setup(world), '1');
		expect(world.waits).toEqual([30_000, 120_000]);
		const said = world.tracker.said('2')[0] ?? '';
		for (const n of ['1', '2', '3']) expect(said).toContain(`try ${n}: claude exited`);
		expect(said).toContain('overloaded, try 3');
		expect(ledger(world).filter((e) => e.ticket === '2' && e.step === 'build')).toHaveLength(3);
		expect(world.trees.has(tree(), 'half-done.txt')).toBe(false);
	});

	it('does not try a lasting or budget failure again', async () => {
		const world = makeWorld();
		world.acts['2'] = 'fail';
		await buildFeature(deps(world), setup(world), '1');
		expect(world.waits).toEqual([]);
		expect(ledger(world).filter((e) => e.ticket === '2' && e.step === 'build')).toHaveLength(1);
	});

	describe('Tickets that keep failing the same way', () => {
		const addTickets = (world: World) => {
			for (const id of ['4', '5', '6', '7']) {
				world.tracker.add({ id, title: `Ticket ${id}`, signals: ['ready'] });
			}
			world.tracker.add({
				id: '1',
				title: 'One escape',
				assignees: ['ann'],
				signals: ['go'],
				children: ['6', '2', '3', '4', '5', '7']
			});
		};

		it('stops before the fourth Ticket and says why on the Feature', async () => {
			const world = makeWorld();
			addTickets(world);
			for (const id of ['2', '4', '5']) world.acts[id] = 'lasting';
			await buildFeature(deps(world), setup(world), '1');
			// #3 waits for #2, so the three failures are #2, #4 and #5
			const tried = ledger(world).filter((e) => e.step === 'build');
			expect(tried.map((e) => e.ticket)).toEqual(['6', '2', '4', '5']);
			expect(world.tracker.signalsOf('1')).toContain('needsInfo');
			const comment = world.tracker.said('1').join('\n');
			expect(comment).toContain('the login is rejected');
			for (const id of ['2', '4', '5']) expect(comment).toContain(`#${id}`);
			expect(world.host.pulls).toHaveLength(1);
		});

		it('does not stop when a different reason breaks the three', async () => {
			const world = makeWorld();
			addTickets(world);
			world.acts['2'] = 'lasting';
			world.acts['4'] = 'lasting';
			world.acts['5'] = 'lasting-other';
			await buildFeature(deps(world), setup(world), '1');
			const tried = ledger(world).filter((e) => e.step === 'build');
			expect(tried.map((e) => e.ticket)).toEqual(['6', '2', '4', '5', '7']);
			expect(world.tracker.said('1').join('\n')).not.toContain('same reason');
		});
	});

	it('does not try again when the Ticket has no budget left for it', async () => {
		const world = makeWorld();
		world.acts['2'] = 'down';
		await buildFeature(
			deps(world),
			setup(world, { limits: { ...setup(world).limits, ticketUsd: 1.5 } }),
			'1'
		);
		expect(world.waits).toEqual([]);
		expect(ledger(world).filter((e) => e.ticket === '2' && e.step === 'build')).toHaveLength(1);
	});

	it("says in the pull request's waiting list that a Ticket waits on a Ticket outside the Feature", async () => {
		const world = makeWorld();
		world.tracker.reference = (id) => ({ id, text: `AB#${id}` });
		world.tracker.add({ id: '4', title: 'Mark the rest', signals: ['ready'], blockedBy: ['90'] });
		world.tracker.add({
			id: '1',
			title: 'One escape',
			assignees: ['ann'],
			signals: ['go'],
			children: ['2', '3', '4']
		});
		await buildFeature(deps(world), setup(world), '1');

		const body = world.host.pulls[0]?.body ?? '';
		expect(body).toContain(
			"- AB#4 Mark the rest: blocked by AB#90, a Ticket outside this Feature: it closes when its Feature's pull request merges. Merge that, then give the Go again."
		);
	});

	it('shows a build tried again as try 2 of 3 in the status file', async () => {
		const world = makeWorld();
		world.acts['2'] = 'flaky';
		await buildFeature(deps(world), setup(world), '1');
		const retries = world.doing.flatMap((d) => (d.kind === 'building' && d.retry ? [d.retry] : []));
		expect(retries).toEqual([{ attempt: 2, of: 3 }]);
	});

	describe('the working Signal on a Ticket', () => {
		it('is on the Ticket, beside ready, while its build Session runs, and off once it is built', async () => {
			const world = makeGitWorld();
			const seen: [string, readonly Signal[]][] = [];
			world.settle = (req) => {
				if (req.kind === 'build')
					seen.push([req.ticket.id, [...world.tracker.signalsOf(req.ticket.id)]]);
				return undefined;
			};
			await buildFeature(deps(world), setup(world), '1');
			expect(seen).toEqual([
				['2', ['ready', 'working']],
				['3', ['ready', 'working']]
			]);
			expect(world.tracker.signalsOf('2')).toEqual(['ready']);
			expect(world.tracker.signalsOf('3')).toEqual(['ready']);
		});

		it('comes off a Ticket handed back, which carries needs info and not ready', async () => {
			const world = makeGitWorld();
			world.acts['2'] = 'fail';
			await buildFeature(deps(world), setup(world), '1');
			expect(world.tracker.signalsOf('2')).toEqual(['needsInfo']);
		});

		it('is never put on a Ticket handed back before a Session', async () => {
			const world = makeWorld();
			const item = world.tracker.items.get('2');
			if (item) world.tracker.items.set('2', { ...item, body: 'Just do it.' });
			const added: string[] = [];
			const real = world.tracker.addSignal;
			world.tracker.addSignal = (id, signal) => {
				if (signal === 'working') added.push(id);
				return real(id, signal);
			};
			await buildFeature(deps(world), setup(world), '1');
			expect(added).not.toContain('2');
			expect(world.tracker.signalsOf('2')).not.toContain('working');
		});

		it('comes off when the run pauses or a person stops it', async () => {
			const paused = makeWorld();
			paused.settle = (req) =>
				req.kind === 'build'
					? { kind: 'paused', why: 'the limit', sessionId: 's', costUsd: 1 }
					: undefined;
			await buildFeature(deps(paused), setup(paused), '1');
			expect(paused.tracker.signalsOf('2')).toEqual(['ready']);

			const stopped = makeWorld();
			stopped.settle = (req) =>
				req.kind === 'build' ? { kind: 'aborted', sessionId: 's', costUsd: 1 } : undefined;
			await buildFeature(deps(stopped), setup(stopped), '1');
			expect(stopped.tracker.signalsOf('2')).toEqual(['ready']);
		});

		it('is taken off a Ticket an earlier run left it on, before the first Session starts', async () => {
			const world = makeGitWorld();
			await world.tracker.addSignal('2', 'working');
			await world.tracker.addSignal('3', 'working');
			const first: (readonly Signal[])[] = [];
			world.settle = (req) => {
				if (req.kind === 'build' && first.length === 0) {
					first.push([...world.tracker.signalsOf('3')]);
				}
				return undefined;
			};
			await buildFeature(deps(world), setup(world), '1');
			// Ticket 3 waits behind 2, and no longer looks worked on
			expect(first).toEqual([['ready']]);
			expect(world.tracker.signalsOf('2')).toEqual(['ready']);
			expect(world.tracker.signalsOf('3')).toEqual(['ready']);
		});

		it('lets a Tracker fault while clearing it reach the caller, which hands the Feature back', async () => {
			const world = makeGitWorld();
			await world.tracker.addSignal('3', 'working');
			world.tracker.removeSignal = (id) =>
				id === '3' ? Promise.reject(new Error('the Tracker is down')) : Promise.resolve();
			await expect(buildFeature(deps(world), setup(world), '1')).rejects.toThrow('down');
			expect(askedOf(world, 'build')).toEqual([]);
		});

		it('leaves the Build order the same', async () => {
			const world = makeGitWorld();
			await buildFeature(deps(world), setup(world), '1');
			expect(subjects(world)).toEqual(['Use it in marks (#3)', 'Share the function (#2)']);
		});
	});

	it('hands back a Ticket whose session stopped, keeping the attempt on a side branch', async () => {
		const world = makeGitWorld();
		world.acts['2'] = 'fail';
		await buildFeature(deps(world), setup(world), '1');
		expect(world.tracker.said('2')[0]).toContain('it reached its budget');
		expect(world.tracker.said('2')[0]).toContain('factory/1-one-escape-attempt-2');
		expect(
			git(world, world.root, 'show', '--name-only', '--format=', 'factory/1-one-escape-attempt-2')
		).toBe('ticket-2.txt');
		expect(world.happened[0]).toEqual({
			kind: 'needs-info',
			feature: '1',
			ticket: '2',
			why: 'it reached its budget',
			next: ticketStep(DEFAULT_SIGNAL_NAMES, 'retry')
		});
		expect(ledger(world)[0]).toMatchObject({
			outcome: 'failed: it reached its budget',
			costUsd: 15.2
		});
	});

	it("names each Ticket in the pull request by the Tracker's reference, and on the Tracker as #N", async () => {
		const world = makeWorld();
		// as Azure Boards references a work item from a pull request on GitHub
		world.tracker.reference = (id) => ({ id, text: `AB#${id}` });
		world.tracker.add({ id: '4', title: 'Mark the rest', signals: ['ready'], blockedBy: ['3'] });
		world.tracker.add({
			id: '1',
			title: 'One escape',
			assignees: ['ann'],
			signals: ['go'],
			children: ['3', '2', '4']
		});
		world.acts['3'] = 'ask';
		await buildFeature(deps(world), setup(world), '1');

		const body = world.host.pulls[0]?.body ?? '';
		expect(body).toContain('- AB#3 Use it in marks: needs info');
		expect(body).toContain('- AB#4 Mark the rest: blocked by AB#3');
		expect(body).not.toMatch(/(?<!AB)#\d/);
		expect(world.tracker.said('1')[0]).toContain('- #4 Mark the rest: blocked by #3');
		expect(body).not.toContain('outside this Feature');
	});

	it('names the Ticket after which the check fails by its reference in the pull request', async () => {
		const world = makeWorld();
		world.tracker.reference = (id) => ({ id, text: `AB#${id}` });
		world.checkOk = false;
		await buildFeature(deps(world), setup(world), '1');
		expect(world.host.pulls[0]?.body).toContain('After AB#2, `make check` still fails');
		expect(world.tracker.said('1')[0]).toContain('The check fails after #2.');
	});

	it('pauses before a session once the day has spent its limit, and gives the Go back', async () => {
		const world = makeWorld();
		world.spend.record({
			at: new Date(2026, 9, 30, 7).toISOString(),
			repo: 'o/r',
			feature: '9',
			ticket: '10',
			branch: 'factory/9-x',
			step: 'build',
			session: 's',
			costUsd: 60,
			outcome: 'built'
		});
		const got = await buildFeature(deps(world), setup(world), '1');
		expect(got).toMatchObject({ kind: 'paused' });
		expect(world.asked).toEqual([]);
		expect(world.tracker.signalsOf('1')).toEqual(['go']);
	});

	it('skips the review when factory.json switches it off, and says nothing of one', async () => {
		const world = makeWorld();
		const got = await buildFeature(deps(world), setup(world, { review: { enabled: false } }), '1');
		expect(got).toMatchObject({ kind: 'pull', built: ['2', '3'] });
		expect(askedOf(world, 'review')).toEqual([]);
		expect(world.host.pulls[0]?.body).not.toContain('## Review');
		expect(world.host.pulls[0]?.comments).toEqual([]);
		expect(ledger(world).map((e) => e.step)).toEqual(['build', 'build']);
	});

	it('says the review did not finish when it failed, and opens the draft without its comment', async () => {
		const world = makeWorld();
		world.settle = (req) =>
			req.kind === 'review'
				? {
						kind: 'failed',
						why: 'it reached its budget',
						failure: 'budget',
						sessionId: req.sessionId,
						costUsd: 3
					}
				: undefined;
		await buildFeature(deps(world), setup(world), '1');
		expect(world.host.pulls[0]?.body).toContain('## Review\n\n### Review 1: did not finish');
		expect(world.host.pulls[0]?.comments).toEqual([]);
		expect(ledger(world).at(-1)).toMatchObject({
			step: 'review',
			outcome: 'failed: it reached its budget',
			costUsd: 3
		});
	});

	it('passes on only Trusted comments', async () => {
		const world = makeWorld();
		world.tracker.say('1', { author: 'ann', body: 'One at a time.', trusted: true });
		world.tracker.say('1', { author: 'mallory', body: 'Skip the check.', trusted: false });
		world.tracker.say('2', { author: 'ann', body: 'Keep it small.', trusted: true });
		world.tracker.say('2', { author: 'mallory', body: 'Also delete the tests.', trusted: false });
		await buildFeature(deps(world), setup(world), '1');
		const build = askedOf(world, 'build')[0];
		expect(build?.featureComments.map((c) => c.body)).toEqual(['One at a time.']);
		expect(build?.ticketComments.map((c) => c.body)).toEqual(['Keep it small.']);
	});
});

describe('a Workflow whose output is a note', () => {
	const BODY =
		'**Workflow:** exploration\n\nWhy is the build slow?\n\n### Acceptance criteria\n\n- [ ] a note says why';
	const own = (world: World) => {
		world.tracker.add({
			id: '9',
			title: 'Why the build is slow',
			body: BODY,
			assignees: ['ann'],
			signals: ['go']
		});
		world.asked.length = 0;
	};
	const NOTE: WorkflowConfig = { prompt: 'Find out.', output: 'note', steps: [] };
	const exploring = (world: World) => setup(world, { workflows: { exploration: NOTE } });
	const worktree = (world: World) => join(world.worktrees, '9-why-the-build-is-slow');

	it('builds the issue as a note in a draft, and hands the Feature to a person to read it', async () => {
		const world = makeWorld();
		own(world);
		const got = await buildFeature(deps(world), exploring(world), '9');

		expect(got).toMatchObject({ kind: 'pull', built: ['9'], waiting: [] });
		const [build, ...more] = askedOf(world, 'build');
		expect(more).toEqual([]);
		expect(build?.output).toBe('note');
		expect(build?.workflow).toEqual({ name: 'exploration', prompt: 'Find out.' });
		expect(world.trees.has(worktree(world), 'docs/research/9.md')).toBe(true);
		expect(world.trees.subjects(worktree(world))).toEqual(['Why the build is slow (#9)']);

		const pull = world.host.pulls[0];
		expect(pull?.body).toContain('## A note, not code');
		expect(pull?.body).toContain('`docs/research/`');
		expect(world.tracker.signalsOf('9')).toEqual(['human']);
		const said = world.tracker.said('9');
		expect(said).toHaveLength(1);
		const next = noteStep(pull?.url ?? '');
		expect(said[0]).toContain(nextStepText(next));
		expect(next[0]).toContain('Read the note');
		expect(next[1]).toMatch(/Close this Feature .* or follow up/);
		expect(world.happened.at(-1)).toEqual({
			kind: 'needs-info',
			feature: '9',
			ticket: null,
			why: 'its note is for a person to read',
			next
		});
	});

	it("keeps a note's fix rounds to the note as well", async () => {
		const world = makeWorld();
		own(world);
		world.checkOk = false;
		world.fixAgent = (req) => {
			world.checkOk = true;
			return { kind: 'fixed', summary: 'fixed', sessionId: req.resume, costUsd: 1 };
		};
		await buildFeature(deps(world), exploring(world), '9');
		expect(askedOf(world, 'fix').map((f) => f.of)).toEqual([{ kind: 'build', output: 'note' }]);
	});

	it('hands back a Ticket whose Session writes no note as one that changed no file', async () => {
		const world = makeWorld();
		own(world);
		world.acts['9'] = 'empty';
		const got = await buildFeature(deps(world), exploring(world), '9');

		expect(got).toMatchObject({ kind: 'nothing' });
		expect(world.host.pulls).toEqual([]);
		expect(world.tracker.signalsOf('9')).toEqual(['needsInfo']);
		expect(world.tracker.said('9')).toHaveLength(2);
		expect(world.tracker.said('9')[0]).toContain('said it built this Ticket but changed no file');
	});

	it('leaves the output out of a Workflow without one, and the Feature with no Signal', async () => {
		const world = makeWorld();
		own(world);
		await buildFeature(
			deps(world),
			setup(world, { workflows: { exploration: { prompt: 'p', steps: [] } } }),
			'9'
		);
		expect(askedOf(world, 'build')[0]).not.toHaveProperty('output');
		expect(askedOf(world, 'fix')).toEqual([]);
		expect(world.host.pulls[0]?.body).not.toContain('A note');
		expect(world.tracker.signalsOf('9')).toEqual([]);
	});
});

describe('a Session that cannot go on', () => {
	const LIMIT_WHY = "the plan's usage limit was reached; it resets at 2026-10-30T20:00:00.000Z";
	const KEY_WHY = 'the session billed an API key; unset ANTHROPIC_API_KEY or pass --use-api-key';
	const cases = [
		['rate-limited', LIMIT_WHY],
		['billing an API key', KEY_WHY]
	] as const;
	const paused = (why: string): Ending => ({
		kind: 'paused',
		why,
		sessionId: 'session-x',
		costUsd: 0
	});
	const workflow = (world: World, flow: WorkflowConfig) => {
		const feature = world.tracker.items.get('1');
		if (feature) world.tracker.items.set('1', { ...feature, body: '**Workflow:** w' });
		return setup(world, { workflows: { w: flow } });
	};
	const critique: WorkflowConfig = {
		steps: [{ name: 'critique', prompt: '/critique', point: 'afterAllTickets' }]
	};

	it.each(cases)(
		'pauses the run, and throws the Ticket away, when a fix round is %s',
		async (_name, why) => {
			const world = makeWorld();
			world.checkOk = false;
			world.settle = (req) => (req.kind === 'fix' ? paused(why) : undefined);
			const got = await buildFeature(deps(world), setup(world), '1');

			expect(got).toEqual({ kind: 'paused', why });
			expect(subjects(world)).toEqual([]);
			expect(has(world, 'ticket-2.txt')).toBe(false);
			expect(world.tracker.signalsOf('1')).toEqual(['go']);
			expect(world.tracker.signalsOf('2')).toEqual(['ready']);
			expect(world.asked.map((r) => r.kind)).toEqual(['build', 'fix']);
			expect(ledger(world).map((e) => [e.step, e.outcome])).toEqual([
				['build', 'built'],
				['fix', `paused: ${why}`]
			]);
		}
	);

	it.each(cases)('pauses the run when the review is %s', async (_name, why) => {
		const world = makeWorld();
		world.settle = (req) => (req.kind === 'review' ? paused(why) : undefined);
		await buildFeature(deps(world), setup(world), '1');

		expect(world.tracker.signalsOf('1')).toEqual(['go']);
		expect(world.doing.at(-1)).toMatchObject({ kind: 'paused', why });
		const body = world.host.pulls[0]?.body ?? '';
		expect(body).toContain(`The run paused because ${why}.`);
		expect(body).not.toContain('The review did not finish.');
		expect(world.host.pulls[0]?.comments).toEqual([]);
		expect(ledger(world).at(-1)).toMatchObject({ step: 'review', outcome: `paused: ${why}` });
	});

	it.each(cases)(
		'pauses the run, and throws the Ticket away, when its build is %s',
		async (_name, why) => {
			const world = makeWorld();
			world.settle = (req) => (req.kind === 'build' ? paused(why) : undefined);
			const got = await buildFeature(deps(world), setup(world), '1');

			expect(got).toEqual({ kind: 'paused', why });
			expect(has(world, 'ticket-2.txt')).toBe(false);
			expect(world.tracker.signalsOf('1')).toEqual(['go']);
			expect(world.tracker.signalsOf('2')).toEqual(['ready']);
			expect(ledger(world).map((e) => [e.step, e.outcome])).toEqual([['build', `paused: ${why}`]]);
		}
	);

	it('keeps the first reason when the review pauses a run that is paused already', async () => {
		const world = makeWorld();
		world.stepAgent = (req) => {
			world.checkOk = false;
			return stepDone(req);
		};
		world.settle = (req) =>
			req.kind === 'fix' ? paused(LIMIT_WHY) : req.kind === 'review' ? paused(KEY_WHY) : undefined;
		await buildFeature(deps(world), workflow(world, critique), '1');

		expect(world.doing.filter((d) => d.kind === 'paused')).toEqual([
			{ kind: 'paused', why: LIMIT_WHY, until: null }
		]);
		expect(world.host.pulls[0]?.body).not.toContain(KEY_WHY);
	});

	it.each(cases)(
		"pauses the run, and gives the Go back, when a Step's Session is %s",
		async (_name, why) => {
			const world = makeWorld();
			world.settle = (req) => (req.kind === 'step' ? paused(why) : undefined);
			await buildFeature(deps(world), workflow(world, critique), '1');

			expect(world.tracker.signalsOf('1')).toEqual(['go']);
			expect(world.host.pulls[0]?.body).toContain(`The run paused because ${why}.`);
		}
	);

	it("throws the work away when a stop lands during a Ticket's check, which no Session reports", async () => {
		const world = makeGitWorld();
		const stop = new AbortController();
		const inner = deps(world);
		const runCheck: Deps['runCheck'] = (command, cwd, env) => {
			if (existsSync(join(cwd, 'ticket-2.txt'))) stop.abort();
			return inner.runCheck(command, cwd, env);
		};
		const got = await buildFeature(
			{ ...inner, runCheck },
			{ ...setup(world), signal: stop.signal },
			'1'
		);

		expect(got).toEqual({ kind: 'stopped' });
		expect(has(world, 'ticket-2.txt')).toBe(false);
		expect(subjects(world).join('\n')).not.toContain('#2');
	});

	// what each kind of work's ledger line says when a person stopped it
	const stops = [
		{ name: "a Ticket's build", kind: 'build', outcome: 'stopped by a person' },
		{ name: 'a fix round', kind: 'fix', outcome: 'round 1 gave up' },
		{ name: 'a Step', kind: 'step', outcome: 'w/critique: stopped by a person' }
	] as const;

	it.each(stops)(
		'ends the run as stopped by a person when $name is stopped, keeping nothing of it',
		async ({ kind, outcome }) => {
			const world = makeWorld();
			world.checkOk = kind !== 'fix';
			world.settle = (req) =>
				req.kind === kind ? { kind: 'aborted', sessionId: 'session-x', costUsd: 1.5 } : undefined;
			const config = kind === 'step' ? workflow(world, critique) : setup(world);
			const got = await buildFeature(deps(world), config, '1');

			expect(got).toEqual({ kind: 'stopped' });
			expect(world.tracker.said('1').at(-1)).toContain('The Nightjar run was stopped by a person.');
			expect(world.host.pulls).toEqual([]);
			expect(left(world)).toEqual([]);
			expect(ledger(world).find((e) => e.step === kind)).toMatchObject({ outcome, costUsd: 1.5 });
		}
	);
});

describe('Workflows', () => {
	const critique = {
		name: 'critique',
		prompt: '/design critique the changed screens',
		point: 'afterAllTickets'
	} as const;
	const polish = {
		name: 'polish',
		prompt: '/design polish what the critique found',
		point: 'afterAllTickets'
	} as const;
	const flow = (over: Partial<WorkflowConfig> = {}): WorkflowConfig => ({
		steps: [critique, polish],
		...over
	});
	const onFeature = (world: World, body: string) => {
		const feature = world.tracker.items.get('1');
		if (feature) world.tracker.items.set('1', { ...feature, body });
	};
	const WORKFLOW_LINE = '**Workflow:** design-review';
	const withFlow = (world: World, over: Partial<WorkflowConfig> = {}) => {
		onFeature(world, WORKFLOW_LINE);
		return setup(world, { workflows: { 'design-review': flow(over) } });
	};
	const body = (world: World) => world.host.pulls[0]?.body ?? '';
	const kinds = (world: World) => world.asked.map((r) => r.kind);

	it('runs a two-Step Workflow before the review: the commits, the notes passed on, the pull request', async () => {
		const world = makeGitWorld();
		let heard = '';
		world.stepAgent = (req) => {
			if (req.step.name === 'critique') {
				mkdirSync(req.notes, { recursive: true });
				writeFileSync(join(req.notes, 'critique.md'), 'tighten the header\n');
			} else {
				heard = readFileSync(join(req.notes, 'critique.md'), 'utf8');
				writeFileSync(join(req.at.folder, 'polish.txt'), heard);
			}
			return stepDone(req);
		};
		const got = await buildFeature(deps(world), withFlow(world), '1');

		expect(got).toMatchObject({ kind: 'pull', built: ['2', '3'] });
		expect(kinds(world)).toEqual(['build', 'build', 'step', 'step', 'review']);
		// critique left notes only, so polish has the one Step commit
		expect(subjects(world)).toEqual([
			'design-review: polish',
			'Use it in marks (#3)',
			'Share the function (#2)'
		]);
		expect(heard).toBe('tighten the header\n');
		expect(git(world, tree(), 'show', 'HEAD:polish.txt')).toBe('tighten the header');
		expect(git(world, tree(), 'log', '-1', '--format=%B')).toContain(
			'Factory-Step: design-review/polish'
		);
		// the notes stay in the worktree and out of git
		expect(readFileSync(join(tree(), '.factory', 'notes', 'critique.md'), 'utf8')).toBe(
			'tighten the header\n'
		);
		expect(git(world, tree(), 'status', '--porcelain')).toBe('');
		expect(git(world, tree(), 'ls-files', '.factory')).toBe('');

		const [first, second] = askedOf(world, 'step');
		expect(first).toMatchObject({
			at: { folder: tree() },
			sessionId: 'session-3',
			workflow: 'design-review',
			step: critique,
			round: 1,
			rounds: 1,
			ticket: null,
			notes: join(tree(), '.factory', 'notes'),
			left: [],
			budgetUsd: LIMITS.ticketUsd
		});
		// the Feature's diff, so the agent picks its own targets
		expect(first?.diff?.text).toContain('+++ b/ticket-3.txt');
		expect(first?.diff?.truncated).toBe(false);
		expect(second).toMatchObject({ sessionId: 'session-4', step: polish });

		expect(body(world)).toContain('## Workflow `design-review`');
		expect(body(world)).toContain('- `critique`: done\n- `polish`: done');
		expect(body(world).indexOf('## Workflow')).toBeLessThan(body(world).indexOf('## Review'));

		expect(ledger(world).map((e) => e.step)).toEqual(['build', 'build', 'step', 'step', 'review']);
	});

	it('throws a Step away that fails on the worktree, and still runs the next one', async () => {
		const world = makeWorld();
		world.stepAgent = (req) => {
			write(world, req.at.folder, `${req.step.name}.txt`);
			const { sessionId } = req;
			if (req.step.name === 'polish') return stepDone(req);
			return { kind: 'blocked', blocker: 'which palette?', sessionId, costUsd: 1 };
		};
		await buildFeature(deps(world), withFlow(world), '1');

		expect(subjects(world)[0]).toBe('design-review: polish');
		expect(subjects(world)).not.toContain('design-review: critique');
		expect(has(world, 'critique.txt')).toBe(false);
		expect(has(world, 'polish.txt')).toBe(true);
		expect(body(world)).toContain('- `critique`: **not done**, it reported itself blocked');
	});

	it('marks a Feature needing info when its Workflow line names no Workflow, and builds nothing', async () => {
		const world = makeWorld();
		onFeature(world, '**Workflow:** nope');
		const got = await buildFeature(
			deps(world),
			setup(world, { workflows: { 'design-review': flow(), quick: flow() } }),
			'1'
		);

		expect(got).toMatchObject({ kind: 'nothing' });
		expect(world.asked).toEqual([]);
		expect(world.tracker.signalsOf('1')).toEqual(['needsInfo']);
		expect(world.tracker.said('1')[0]).toContain('`nope`');
		expect(world.tracker.said('1')[0]).toContain('`design-review`, `quick`');
		expect(world.host.pulls).toEqual([]);
	});

	it('refuses a Workflow that cannot run on this machine, for its Features only', async () => {
		const world = makeWorld();
		const config = setup(world, {
			...withFlow(world),
			brokenWorkflows: { 'design-review': 'step critique names /gone, which claude does not load' }
		});
		const got = await buildFeature(deps(world), config, '1');
		expect(got).toMatchObject({ kind: 'nothing' });
		expect(world.asked).toEqual([]);
		expect(world.tracker.signalsOf('1')).toEqual(['needsInfo']);
		expect(world.tracker.said('1')[0]).toContain('names /gone');
	});

	it('runs no Step when a Feature picks none and there is no default, and builds as before', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world, { workflows: { 'design-review': flow() } }), '1');
		expect(kinds(world)).toEqual(['build', 'build', 'review']);
		expect(body(world)).not.toContain('Workflow');
	});

	it("gives each Ticket's build Session the Workflow's prompt, and none to a Workflow without one", async () => {
		const world = makeWorld();
		await buildFeature(
			deps(world),
			withFlow(world, { prompt: 'Show the bug with a test first.', steps: [] }),
			'1'
		);
		const builds = askedOf(world, 'build');
		expect(builds).toHaveLength(2);
		for (const b of builds) {
			expect(b.workflow).toEqual({
				name: 'design-review',
				prompt: 'Show the bug with a test first.'
			});
		}
		expect(kinds(world)).toEqual(['build', 'build', 'review']);

		const plain = makeWorld();
		await buildFeature(deps(plain), withFlow(plain), '1');
		expect(askedOf(plain, 'build').every((b) => b.workflow === undefined)).toBe(true);
	});

	it('names in the pull request the test a Session says shows the bug', async () => {
		const world = makeWorld();
		world.tests['2'] = 'src/marks.spec.ts: keeps the mark after a rename';
		await buildFeature(deps(world), withFlow(world, { prompt: 'p', steps: [] }), '1');
		expect(body(world)).toContain(
			'## Test that shows the bug\n\n- #2: src/marks.spec.ts: keeps the mark after a rename'
		);
		const none = makeWorld();
		await buildFeature(deps(none), withFlow(none, { prompt: 'p', steps: [] }), '1');
		expect(body(none)).not.toContain('Test that shows');
	});

	it('runs the default Workflow of a Feature without a Workflow line', async () => {
		const world = makeWorld();
		await buildFeature(
			deps(world),
			setup(world, { workflows: { 'design-review': flow() }, defaultWorkflow: 'design-review' }),
			'1'
		);
		expect(kinds(world)).toEqual(['build', 'build', 'step', 'step', 'review']);
	});

	it('stays on a built Ticket until its afterEachTicket Steps are done', async () => {
		const world = makeGitWorld();
		const lint = { name: 'lint', prompt: 'lint it', point: 'afterEachTicket' } as const;
		const during: [string, readonly Signal[]][] = [];
		world.stepAgent = (req) => {
			const id = req.ticket?.id ?? '';
			during.push([id, [...world.tracker.signalsOf(id)]]);
			write(world, req.at.folder, `lint-${id}.txt`);
			return stepDone(req);
		};
		await buildFeature(deps(world), withFlow(world, { steps: [lint] }), '1');
		expect(during).toEqual([
			['2', ['ready', 'working']],
			['3', ['ready', 'working']]
		]);
		expect(world.tracker.signalsOf('2')).toEqual(['ready']);
		expect(world.tracker.signalsOf('3')).toEqual(['ready']);
	});

	it('runs an afterEachTicket Step after each Ticket, committed on its own', async () => {
		const world = makeWorld();
		const lint = { name: 'lint', prompt: 'lint it', point: 'afterEachTicket' } as const;
		world.stepAgent = (req) => {
			write(world, req.at.folder, `lint-${req.ticket?.id ?? ''}.txt`);
			return stepDone(req);
		};
		await buildFeature(deps(world), withFlow(world, { steps: [lint] }), '1');

		expect(subjects(world)).toEqual([
			'design-review: lint (after #3)',
			'Use it in marks (#3)',
			'design-review: lint (after #2)',
			'Share the function (#2)'
		]);
		expect(kinds(world)).toEqual(['build', 'step', 'build', 'step', 'review']);
		// an afterEachTicket Step runs without the Feature's diff
		expect(askedOf(world, 'step').map((s) => s.diff)).toEqual([undefined, undefined]);
		expect(body(world)).toContain('- `lint` (after #2): done\n- `lint` (after #3): done');
	});

	it('leaves the afterAllTickets Steps unrun while a Ticket waits, and says so', async () => {
		const world = makeWorld();
		world.acts['3'] = 'ask';
		await buildFeature(deps(world), withFlow(world), '1');
		expect(kinds(world)).not.toContain('step');
		expect(body(world)).toContain(
			'- `critique`: **not done**, it did not run, as the Feature is not complete'
		);
	});

	it('does not run a Step the branch already holds when a later run goes on', async () => {
		const world = makeWorld();
		world.stepAgent = (req) => {
			write(world, req.at.folder, `${req.step.name}.txt`);
			return stepDone(req);
		};
		const config = withFlow(world);
		await buildFeature(deps(world), config, '1');
		const first = kinds(world).length;
		await world.tracker.addSignal('1', 'go');
		await buildFeature(deps(world), config, '1');

		expect(kinds(world).slice(first)).toEqual(['review']);
		expect(body(world)).toContain('- `critique`: done\n- `polish`: done');
	});

	it("serves the Workflow's command on the run's first reserved port while its Steps run", async () => {
		const world = makeWorld();
		await buildFeature(
			deps(world),
			{ ...withFlow(world, { serve: 'npm run dev' }), portEnv: PORTS },
			'1'
		);
		expect(world.serves).toEqual([{ command: 'npm run dev', cwd: tree(), port: 4500 }]);
		expect(world.stopped).toBe(1);
	});

	it("gives a Step's fix rounds the Step's Session and the Workflow's extras", async () => {
		const world = makeWorld();
		const extras = { allowedCommands: ['npm run e2e'], localNetwork: true };
		world.stepAgent = (req) => {
			write(world, req.at.folder, 'critique.txt');
			world.checkOk = false;
			return stepDone(req);
		};
		world.fixAgent = (req) => {
			world.checkOk = true;
			return { kind: 'fixed', summary: 'fixed', sessionId: req.resume, costUsd: 1 };
		};
		await buildFeature(deps(world), withFlow(world, { steps: [critique], ...extras }), '1');

		expect(askedOf(world, 'fix')).toMatchObject([
			{ of: { kind: 'step', step: critique, extras }, resume: 'session-3', round: 1 }
		]);
		expect(subjects(world)[0]).toBe('design-review: critique');
	});
});

describe('the publish mark in the pull request', () => {
	const mark = (world: World) => publishMarkOf(world.host.pulls[0]?.body ?? '');
	// a Review that asks for changes `times` times, then approves
	const changesFor = (world: World, times: number) => {
		let reviews = 0;
		world.reviewAgent = (req) => reviewed(req, (reviews += 1) <= times ? 'changes' : 'approve');
	};

	it('says complete and approved when every Ticket is built, the check is green and the Review approves', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		expect(mark(world)).toEqual({ complete: true, approved: true });
	});

	it('reads the last Review of the build: approved once a Review round leads to an approval', async () => {
		const world = makeWorld();
		changesFor(world, 1);
		await buildFeature(deps(world), setup(world), '1');
		expect(mark(world)).toEqual({ complete: true, approved: true });
	});

	it('says not approved when the last Review asks for changes, did not finish or is switched off', async () => {
		const changes = makeWorld();
		changesFor(changes, 99);
		await buildFeature(deps(changes), setup(changes), '1');
		expect(mark(changes)).toEqual({ complete: true, approved: false });

		const failed = makeWorld();
		failed.settle = (req) =>
			req.kind === 'review'
				? { kind: 'failed', why: 'budget', failure: 'budget', sessionId: req.sessionId, costUsd: 1 }
				: undefined;
		await buildFeature(deps(failed), setup(failed), '1');
		expect(mark(failed)).toEqual({ complete: true, approved: false });

		const off = makeWorld();
		await buildFeature(deps(off), setup(off, { review: { enabled: false } }), '1');
		expect(mark(off)).toEqual({ complete: true, approved: false });
	});

	it('says not complete when a Ticket is left waiting, or the check stays red', async () => {
		const waiting = makeWorld();
		waiting.acts['3'] = 'fail';
		await buildFeature(deps(waiting), setup(waiting), '1');
		expect(mark(waiting)).toEqual({ complete: false, approved: true });

		const red = makeWorld();
		red.checkOk = false;
		await buildFeature(deps(red), setup(red), '1');
		expect(mark(red)?.complete).toBe(false);
	});

	it('keeps the mark that Nightjar published the pull request across a rebuild, so its Pull-check pass keeps to it', async () => {
		const world = makeWorld();
		const d = deps(world);
		await buildFeature(d, setup(world), '1');
		const [pull] = await world.host.nightjarDrafts();
		if (pull === undefined) throw new Error('no draft was opened');
		await world.host.publish(pull.pull);
		await world.host.editBody(pull.pull, markPublished(pull.body));

		await buildFeature(d, setup(world), '1');
		expect(publishedByNightjar(world.host.pulls[0]?.body ?? '')).toBe(true);
		expect((await world.host.nightjarDrafts()).map((p) => p.pull)).toEqual([pull.pull]);
	});

	it('writes no such mark on a rebuild of a pull request a person marked ready', async () => {
		const world = makeWorld();
		const d = deps(world);
		await buildFeature(d, setup(world), '1');
		const pull = world.host.pulls[0];
		if (pull === undefined) throw new Error('no draft was opened');
		world.host.markReady(pull);

		await buildFeature(d, setup(world), '1');
		expect(publishedByNightjar(world.host.pulls[0]?.body ?? '')).toBe(false);
	});
});

describe('the cost split in the pull request', () => {
	const body = (world: World) => world.host.pulls[0]?.body ?? '';
	const feature = (world: World, text: string) => {
		const item = world.tracker.items.get('1');
		if (item) world.tracker.items.set('1', { ...item, body: text });
	};

	it('splits a Ticket into its build and its fix rounds, and the review apart', async () => {
		const world = makeWorld();
		world.checkOk = false;
		await buildFeature(deps(world), setup(world), '1');

		expect(body(world)).toContain(
			[
				'## Cost',
				'',
				'Estimated cost of this run: $6.50.',
				'',
				'- #2 Share the function: build $3.00, fix $3.00',
				'- Review: $0.50'
			].join('\n')
		);
	});

	it('lists a Ticket by its build alone, and leaves out one that had no Session', async () => {
		const world = makeWorld();
		// #4 waits for #3, which asks a question, so #4 never gets a Session
		world.tracker.add({ id: '4', title: 'Document it', signals: ['ready'], blockedBy: ['3'] });
		const item = world.tracker.items.get('1');
		if (item) world.tracker.items.set('1', { ...item, children: ['3', '2', '4'] });
		world.acts['3'] = 'ask';
		await buildFeature(deps(world), setup(world), '1');

		expect(body(world)).toContain(
			'- #2 Share the function: build $3.00\n- #3 Use it in marks: build $2.00\n'
		);
		expect(body(world)).not.toContain('#4 Document it: build');
	});

	it("counts a Step's fix rounds under Steps, not under the Ticket's fix", async () => {
		const world = makeWorld();
		const lint = { name: 'lint', prompt: 'lint it', point: 'afterEachTicket' } as const;
		const critique = { name: 'critique', prompt: 'look', point: 'afterAllTickets' } as const;
		feature(world, '**Workflow:** w');
		// the Step breaks the check, except after #3; its fix round puts it right
		world.stepAgent = (req) => {
			world.checkOk = req.ticket?.id === '3';
			return stepDone(req);
		};
		world.fixAgent = (req) => {
			world.checkOk = true;
			return { kind: 'fixed', summary: 'fixed', sessionId: req.resume, costUsd: 1 };
		};
		await buildFeature(
			deps(world),
			setup(world, { workflows: { w: { steps: [lint, critique] } } }),
			'1'
		);

		expect(body(world)).toContain(
			[
				'Estimated cost of this run: $11.50.',
				'',
				'- #2 Share the function: build $3.00, Steps $2.00',
				'- #3 Use it in marks: build $3.00, Steps $1.00',
				'- Steps after all Tickets: $2.00',
				'- Review: $0.50'
			].join('\n')
		);
	});

	it('leaves the review out when it is off', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world, { review: { enabled: false } }), '1');

		expect(body(world)).toContain(
			'Estimated cost of this run: $6.00.\n\n- #2 Share the function: build $3.00\n- #3 Use it in marks: build $3.00\n\n'
		);
		expect(body(world)).not.toContain('- Review:');
	});

	it('shows the split of a paused run for the Sessions it ran', async () => {
		const world = makeWorld();
		world.settle = (req) =>
			req.kind === 'build' && req.ticket.id === '3'
				? { kind: 'paused', why: 'the limit', sessionId: req.sessionId, costUsd: 1.5 }
				: undefined;
		await buildFeature(deps(world), setup(world), '1');

		expect(body(world)).toContain(
			[
				'Estimated cost of this run: $5.00.',
				'',
				'- #2 Share the function: build $3.00',
				'- #3 Use it in marks: build $1.50',
				'- Review: $0.50'
			].join('\n')
		);
	});
});

describe('the next step in each comment', () => {
	const said = (world: World, id: string) => world.tracker.said(id)[0] ?? '';

	it('tells a person how to answer a Ticket back to Nightjar', async () => {
		const world = makeWorld();
		world.acts['2'] = 'ask';
		await buildFeature(deps(world), setup(world), '1');
		expect(said(world, '2')).toContain('**Next step**');
		expect(said(world, '2')).toContain('add `ready-for-agent`');
		expect(said(world, '2')).toContain('On its Feature, remove `needs-info` and add `factory-go`');
		expect(said(world, '2')).toMatch(/\n\n---\n_Built by Nightjar\._$/);
	});

	it('uses the Signal names factory.json sets', async () => {
		const world = makeWorld();
		world.acts['2'] = 'ask';
		const signals = { ...DEFAULT_SIGNAL_NAMES, go: 'run-it' };
		await buildFeature(deps(world), setup(world, { signals }), '1');
		expect(said(world, '2')).toContain('add `run-it`');
		expect(said(world, '2')).not.toContain('factory-go');
	});

	it('tells a person what to fix when a Session failed', async () => {
		const world = makeWorld();
		world.acts['2'] = 'fail';
		await buildFeature(deps(world), setup(world), '1');
		expect(said(world, '2')).toContain('Read the reason above');
	});

	it('tells a person to build it when the question rounds are used up', async () => {
		const world = makeWorld();
		world.acts['2'] = 'ask';
		world.tracker.say('2', { author: 'ann', body: `${QUESTIONS_MARK}\nround 1`, trusted: true });
		world.tracker.say('2', { author: 'ann', body: `${QUESTIONS_MARK}\nround 2`, trusted: true });
		await buildFeature(deps(world), setup(world), '1');
		expect(world.tracker.said('2').at(-1)).toContain('Build it yourself');
	});

	it('tells a person to clear needs-info on a Feature that stopped before building', async () => {
		const world = makeWorld();
		world.setupOk = false;
		await buildFeature(deps(world), setup(world, { setupCommand: 'make deps' }), '1');
		expect(said(world, '1')).toContain('On this Feature, remove `needs-info` and add `factory-go`');
	});

	it('sends a person from a Feature that built nothing to its waiting Tickets', async () => {
		const world = makeWorld();
		world.acts['2'] = 'ask';
		await buildFeature(deps(world), setup(world), '1');
		expect(said(world, '1')).toContain('waiting Tickets');
	});

	it('sends a person from a red check to the branch, not to a waiting Ticket', async () => {
		const world = makeWorld();
		world.checkOk = false;
		await buildFeature(deps(world), setup(world), '1');
		expect(said(world, '1')).toContain('Fix the failing check on the branch');
		expect(said(world, '1')).toContain('The check fails after #2');
	});

	it('leaves a Next step off the review comment, which hands nothing to a person', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		expect(world.host.pulls[0]?.comments[0]).toContain('Nightjar review');
		expect(world.host.pulls[0]?.comments[0]).not.toContain('Next step');
	});
});

describe('the Pull-check pass in --watch', () => {
	const FAILURES = [
		{
			check: 'CI / test',
			job: 'test',
			step: 'Run npm test',
			logTail: 'FAIL src/a.spec.ts\nError: TZ is not set'
		},
		{ check: 'CI / lint', job: 'lint', step: 'Run eslint', logTail: 'src/b.ts: 1 problem' }
	];

	// Feature 1 built into a draft whose Pull checks then failed, and Feature 10 in the Queue after it.
	async function redDraft(world: World) {
		await buildFeature(deps(world), setup(world), '1');
		const pull = world.host.pulls[0];
		if (pull === undefined) throw new Error('no draft was opened');
		world.host.setChecks(pull, { pending: false, failed: FAILURES });
		world.tracker.add({
			id: '10',
			title: 'Next',
			assignees: ['ann'],
			signals: ['go'],
			children: ['11']
		});
		world.tracker.add({ id: '11', title: 'Ticket 11', signals: ['ready'] });
		// the fix Session changes a file, as one that fixes something does
		world.fixAgent = (req) => {
			if (req.of.kind === 'pullChecks') write(world, req.at.folder, 'ci.txt');
			return {
				kind: 'fixed',
				summary: 'Set TZ in the test job.',
				sessionId: req.resume,
				costUsd: 1
			};
		};
		// what happened from here on
		world.asked.length = 0;
		return pull;
	}

	// a new run of --watch, its seams and setup changed by `o`
	function watch(
		world: World,
		o: { on?: boolean; deps?: Partial<Deps>; setup?: Partial<Setup> } = {}
	): QueueDeps {
		const d = { ...deps(world), ...o.deps };
		const stop = new AbortController();
		const s = setup(world, o.setup);
		const pass = pullChecksPass({ enabled: o.on ?? true }, world.host, (red) =>
			fixPullChecks(d, s, red)
		);
		return {
			tracker: world.tracker,
			person: 'ann',
			build: ({ id }) => buildFeature(d, s, id),
			status: d.status,
			now: d.now,
			say: () => undefined,
			// the first idle tick stops the run
			sleep: () => {
				stop.abort();
				return Promise.resolve();
			},
			signal: stop.signal,
			...(pass === null ? {} : { pullChecks: pass })
		};
	}

	it("fixes a red draft before the next Feature: one Session that resumes the head commit's, given each failure", async () => {
		const world = makeWorld();
		await redDraft(world);
		expect(await queue(watch(world), false)).toBe(130);

		const [first, ...rest] = world.asked;
		// the head commit is Ticket 3's, built in the second Session
		expect(first).toMatchObject({
			kind: 'fix',
			of: { kind: 'pullChecks' },
			resume: 'session-2',
			round: 1,
			at: { branch: 'factory/1-one-escape', folder: tree() },
			budgetUsd: LIMITS.pullFixUsd
		});
		const tail = first?.kind === 'fix' ? first.tail : '';
		for (const f of FAILURES) {
			expect(tail).toContain(f.check);
			expect(tail).toContain(`job ${f.job}`);
			expect(tail).toContain(`step ${f.step}`);
			expect(tail).toContain(f.logTail.split('\n').at(-1));
		}
		// then Feature 10, built as before
		expect(rest.map((r) => r.kind)).toEqual(['build', 'review']);
		expect(rest[0]).toMatchObject({ ticket: { id: '11' } });
	});

	it("resumes the head commit's Session while this machine has it, and starts no new one", async () => {
		const world = makeWorld();
		await redDraft(world);
		await queue(watch(world), false);
		expect(askedOf(world, 'fix')[0]?.of).toEqual({ kind: 'pullChecks' });
	});

	describe("when the head commit's Session is gone", () => {
		// the new Sessions of the run are named fresh-1, fresh-2 and so on
		function fresh() {
			let n = 0;
			return { newId: () => `fresh-${String((n += 1))}` };
		}

		it("starts a fresh Session given the Feature, the branch's diff and each failed Pull check, and does not fail", async () => {
			const world = makeWorld();
			await redDraft(world);
			world.goneSessions.add('session-2');
			expect(await queue(watch(world, { deps: fresh() }), false)).toBe(130);

			const [first] = askedOf(world, 'fix');
			expect(first).toMatchObject({
				of: { kind: 'pullChecks', fresh: { feature: { id: '1', title: 'One escape' } } },
				resume: 'fresh-1',
				round: 1,
				budgetUsd: LIMITS.pullFixUsd
			});
			const given = first?.of.kind === 'pullChecks' ? first.of.fresh : undefined;
			// every Ticket's work is in the diff, as the Session that built it is not here to tell
			expect(given?.diff.text).toContain('ticket-2.txt');
			expect(given?.diff.text).toContain('ticket-3.txt');
			for (const f of FAILURES) {
				expect(first?.tail).toContain(f.check);
				expect(first?.tail).toContain(`step ${f.step}`);
				expect(first?.tail).toContain(f.logTail.split('\n').at(-1));
			}
			expect(world.tracker.signalsOf('1')).toEqual([]);
		});

		it('then commits with its Factory-Pull-Fix trailer and pushes, as a resumed round does', async () => {
			const world = makeWorld();
			await redDraft(world);
			world.goneSessions.add('session-2');
			const before = world.trees.messages(tree());
			await queue(watch(world, { deps: fresh() }), false);

			const after = world.trees.messages(tree());
			expect(after.slice(1)).toEqual(before);
			expect(after[0]?.split('\n')[0]).toBe('Fix the Pull checks, round 1');
			expect(after[0]).toMatch(/\nFactory-Pull-Fix: 1\nFactory-Session: fresh-1$/);
			expect(world.host.pushes.filter((p) => p.branch === 'factory/1-one-escape')).toHaveLength(2);
			expect(world.host.pulls[0]?.body).toContain('Pull checks');
			expect(ledger(world).find((e) => e.step === 'pullChecks')?.session).toBe('fresh-1');
		});

		it("runs the check's own fix rounds in the new Session", async () => {
			const world = makeWorld();
			await redDraft(world);
			world.goneSessions.add('session-2');
			world.checkOk = false;
			world.fixAgent = (req) => {
				write(world, req.at.folder, `fix-${String(req.round)}.txt`);
				if (req.of.kind === 'build') world.checkOk = true;
				return { kind: 'fixed', summary: 'Fixed.', sessionId: req.resume, costUsd: 1 };
			};
			await queue(watch(world, { deps: fresh() }), false);
			expect(askedOf(world, 'fix').map((f) => [f.of.kind, f.resume])).toEqual([
				['pullChecks', 'fresh-1'],
				['build', 'fresh-1']
			]);
			expect(world.trees.subjects(tree())[0]).toBe('Fix the Pull checks, round 1');
		});

		it('starts a fresh Session also when the head commit names no Session', async () => {
			const world = makeWorld();
			const pull = await redDraft(world);
			world.host.pushedByPerson(pull, 'Tidy\n\nFactory-Ticket: #9');
			await queue(watch(world, { deps: fresh() }), false);
			expect(askedOf(world, 'fix')[0]).toMatchObject({
				of: { kind: 'pullChecks', fresh: {} },
				resume: 'fresh-1'
			});
			expect(world.trees.subjects(tree())[0]).toBe('Fix the Pull checks, round 1');
		});
	});

	it('commits a green fix as one new commit with a Factory-Pull-Fix: 1 trailer and pushes it, the earlier commits unchanged', async () => {
		const world = makeWorld();
		await redDraft(world);
		const before = world.trees.messages(tree());
		await queue(watch(world), false);

		const after = world.trees.messages(tree());
		expect(after.slice(1)).toEqual(before);
		expect(after[0]?.split('\n')[0]).toBe('Fix the Pull checks, round 1');
		expect(after[0]).toContain('Set TZ in the test job.');
		expect(after[0]).toMatch(/\nFactory-Pull-Fix: 1\nFactory-Session: session-2$/);
		expect(world.checks.map((c) => c.cwd)).toContain(tree());
		expect(world.host.pushes.filter((p) => p.branch === 'factory/1-one-escape')).toHaveLength(2);
		// Feature 1 holds no Signal again, and Feature 10 was built after it
		expect(world.tracker.signalsOf('1')).toEqual([]);
		expect(world.host.pulls.map((p) => p.head)).toEqual([
			'factory/1-one-escape',
			'factory/10-next'
		]);
	});

	it('runs no review and no Step after the fix', async () => {
		const world = makeWorld();
		await redDraft(world);
		await queue(watch(world), false);
		const reviews = askedOf(world, 'review');
		expect(reviews.map((r) => r.feature.id)).toEqual(['10']);
		expect(askedOf(world, 'step')).toEqual([]);
		expect(world.host.pulls[0]?.comments).toHaveLength(1);
	});

	it('holds the Feature as working while the fix runs', async () => {
		const world = makeWorld();
		await redDraft(world);
		const signals: string[][] = [];
		world.fixAgent = (req) => {
			signals.push([...world.tracker.signalsOf('1')]);
			write(world, req.at.folder, 'ci.txt');
			return { kind: 'fixed', summary: 'Fixed.', sessionId: req.resume, costUsd: 1 };
		};
		await queue(watch(world), false);
		expect(signals[0]).toEqual(['working']);
		expect(world.tracker.signalsOf('1')).toEqual([]);
	});

	it('runs the check with the usual fix rounds, in the same Session, before it pushes', async () => {
		const world = makeWorld();
		await redDraft(world);
		let checks = 0;
		const d = watch(world);
		world.checkOk = false;
		world.fixAgent = (req) => {
			write(world, req.at.folder, `fix-${String(req.round)}.txt`);
			// the check is green after the first of its own fix rounds
			if (req.of.kind === 'build') world.checkOk = true;
			checks += 1;
			return {
				kind: 'fixed',
				summary: `Fix ${String(checks)}.`,
				sessionId: req.resume,
				costUsd: 1
			};
		};
		await queue(d, false);
		const fixes = askedOf(world, 'fix');
		expect(fixes.map((f) => [f.of.kind, f.resume])).toEqual([
			['pullChecks', 'session-2'],
			['build', 'session-2']
		]);
		expect(world.trees.subjects(tree())[0]).toBe('Fix the Pull checks, round 1');
		expect(world.host.pushes.filter((p) => p.branch === 'factory/1-one-escape')).toHaveLength(2);
	});

	it('keeps a fix that leaves the check red on an attempt branch, and pushes nothing', async () => {
		const world = makeWorld();
		await redDraft(world);
		const before = world.trees.messages(tree());
		world.checkOk = false;
		await queue(watch(world), false);
		expect(world.trees.messages(tree())).toEqual(before);
		expect(world.trees.sides.get('factory/1-one-escape-attempt-pull-fix-1')).toContain('ci.txt');
		expect(world.host.pushes.filter((p) => p.branch === 'factory/1-one-escape')).toHaveLength(1);
		expect(world.tracker.signalsOf('1')).toEqual(['human']);
	});

	describe('a fix whose push is rejected because a person pushed to the draft', () => {
		const SIDE = 'factory/1-one-escape-attempt-push';

		// the person pushes to the draft while the fix Session runs
		async function beaten(world: World) {
			const pull = await redDraft(world);
			const fix = world.fixAgent;
			world.fixAgent = (req) => {
				if (req.of.kind === 'pullChecks') world.host.pushedByPerson(pull);
				return fix(req);
			};
			return pull;
		}

		it('hands the Feature to a person with one comment naming the side branch that keeps the fix', async () => {
			const world = makeWorld();
			await beaten(world);
			const said = world.tracker.said('1').length;
			expect(await queue(watch(world), false)).toBe(130);

			expect(world.tracker.signalsOf('1')).toEqual(['human']);
			const comments = world.tracker.said('1').slice(said);
			expect(comments).toHaveLength(1);
			expect(comments[0]).toContain('factory/1-one-escape');
			expect(comments[0]).toContain(`\`${SIDE}\``);
			expect(comments[0]).toContain('will not push to this draft pull request again');
			expect(comments[0]).toContain('**Next step**');
			expect(comments[0]?.endsWith(FOOTER)).toBe(true);
			// the fix is kept aside, and the branch here is the person's
			expect(world.trees.sides.get(SIDE)).toEqual(['ci.txt']);
			expect(world.trees.subjects(tree())[0]).toBe('Fix a typo');
			expect(world.host.pushes.filter((p) => p.branch === 'factory/1-one-escape')).toHaveLength(1);
			// the Queue still goes on
			expect(askedOf(world, 'build').map((b) => b.ticket.id)).toEqual(['11']);
		});

		it("then leaves the draft alone because its head commit is not Nightjar's, not for commits the Code host lacks", async () => {
			const world = makeWorld();
			await beaten(world);
			await queue(watch(world), false);
			await world.tracker.removeSignal('1', 'human');
			world.asked.length = 0;
			const said: string[] = [];
			await queue(watch(world, { deps: { say: (line) => said.push(line) } }), false);

			expect(askedOf(world, 'fix')).toEqual([]);
			expect(said).toContain(
				"https://code.example/pull/100: left alone, its head commit is not Nightjar's"
			);
		});

		it('counts a push that failed as done when the Code host holds the fix', async () => {
			const world = makeWorld();
			await redDraft(world);
			world.host.failPushes = { why: 'the connection was reset', lands: true };
			await queue(watch(world), false);

			expect(world.tracker.signalsOf('1')).toEqual([]);
			expect(world.trees.subjects(tree())[0]).toBe('Fix the Pull checks, round 1');
			expect(world.trees.sides.has(SIDE)).toBe(false);
			expect(world.host.pulls[0]?.body).toContain('Set TZ in the test job.');
		});
	});

	it("leaves alone a draft whose head commit is not Nightjar's", async () => {
		const world = makeWorld();
		const pull = await redDraft(world);
		world.host.pushedByPerson(pull);
		await queue(watch(world), false);
		expect(askedOf(world, 'fix')).toEqual([]);
		expect(world.host.pushes.filter((p) => p.branch === 'factory/1-one-escape')).toHaveLength(1);
		expect(world.tracker.signalsOf('1')).toEqual([]);
		// the Queue still goes on
		expect(askedOf(world, 'build').map((b) => b.ticket.id)).toEqual(['11']);
	});

	it('leaves a red draft alone with the pass off', async () => {
		const world = makeWorld();
		await redDraft(world);
		await queue(watch(world, { on: false }), false);
		expect(askedOf(world, 'fix')).toEqual([]);
		expect(world.host.pushes.filter((p) => p.branch === 'factory/1-one-escape')).toHaveLength(1);
	});

	it("takes no draft once the day's spend has reached the daily limit", async () => {
		const world = makeWorld();
		const pull = await redDraft(world);
		const s = setup(world, { limits: { ...LIMITS, dailyUsd: 1 } });
		const got = await fixPullChecks(deps(world), s, {
			feature: '1',
			draft: {
				pull: { id: pull.id, url: pull.url },
				branch: pull.head,
				headCommit: '',
				body: pull.body,
				checks: pull.checks,
				personEngaged: false
			}
		});
		expect(got).toMatchObject({ kind: 'paused' });
		expect(world.asked).toEqual([]);
		expect(world.tracker.signalsOf('1')).toEqual([]);
	});
});

// The Logbook entries of one kind that the world's build loop wrote, of every Feature.
const loggedOf = <K extends LogbookEntry['kind']>(world: World, kind: K) => {
	const of = (e: LogbookEntry): e is Extract<LogbookEntry, { kind: K }> => e.kind === kind;
	return world.logbook.all().filter(of);
};

describe('the limits of the Pull-check pass', () => {
	const FAILURES = [
		{ check: 'CI / test', job: 'test', step: 'Run npm test', logTail: 'Error: TZ is not set' },
		{ check: 'CI / lint', job: 'lint', step: 'Run eslint', logTail: 'src/b.ts: 1 problem' }
	];
	const BRANCH = 'factory/1-one-escape';

	// Feature 1 built into a draft whose Pull checks then failed; each fix Session changes a file of its round.
	async function redDraft(world: World) {
		await buildFeature(deps(world), setup(world), '1');
		const pull = world.host.pulls[0];
		if (pull === undefined) throw new Error('no draft was opened');
		world.host.setChecks(pull, { pending: false, failed: FAILURES });
		world.fixAgent = (req) => {
			write(world, req.at.folder, `ci-${String(req.round)}-${req.of.kind}.txt`);
			return { kind: 'fixed', summary: 'Set TZ.', sessionId: req.resume, costUsd: 1 };
		};
		world.asked.length = 0;
		return pull;
	}

	// a new run of --watch that ends on its first idle tick
	function watch(world: World, o: { deps?: Partial<Deps>; setup?: Partial<Setup> } = {}) {
		const d = { ...deps(world), ...o.deps };
		const s = setup(world, o.setup);
		const stop = new AbortController();
		const pass = pullChecksPass({ enabled: true }, world.host, (red) => fixPullChecks(d, s, red));
		return queue(
			{
				tracker: world.tracker,
				person: 'ann',
				build: ({ id }) => buildFeature(d, s, id),
				status: d.status,
				now: d.now,
				say: () => undefined,
				sleep: () => {
					stop.abort();
					return Promise.resolve();
				},
				signal: stop.signal,
				...(pass === null ? {} : { pullChecks: pass })
			},
			false
		);
	}

	const fixes = (world: World) => askedOf(world, 'fix');
	const pushes = (world: World) => world.host.pushes.filter((p) => p.branch === BRANCH);
	const lastSaid = (world: World) => world.tracker.said('1').at(-1) ?? '';
	const failRed = (world: World, pull: Pull) =>
		world.host.setChecks(pull, { pending: false, failed: FAILURES });

	describe("the round's Logbook entries", () => {
		// the Logbook entries written since `from`: a Signal as +name or -name, any other by its kind
		const since = (world: World, from: number) =>
			world.logbook
				.all()
				.slice(from)
				.map((e) => (e.kind === 'signal' ? `${e.on ? '+' : '-'}${e.signal}` : e.kind));
		const failing = FAILURES.map(({ check, job, step }) => ({ check, job, step }));

		it('writes a fix that was pushed: the failing Pull checks, the round of its limit, and the Session it resumed', async () => {
			const world = makeWorld();
			await redDraft(world);
			const from = world.logbook.all().length;
			await watch(world);
			expect(loggedOf(world, 'pullFix')).toEqual([
				{
					at: new Date(2026, 9, 30, 9).toISOString(),
					feature: '1',
					kind: 'pullFix',
					round: 1,
					rounds: 2,
					failing,
					end: 'pushed',
					session: 'session-2'
				}
			]);
			expect(since(world, from).slice(0, 3)).toEqual(['+working', 'pullFix', '-working']);
		});

		it('writes a round that gave up, and the hand-over to a person', async () => {
			const world = makeWorld();
			await redDraft(world);
			const from = world.logbook.all().length;
			world.fixAgent = (req) => ({ kind: 'gaveUp', sessionId: req.resume, costUsd: 1 });
			await watch(world);
			expect(loggedOf(world, 'pullFix')).toMatchObject([
				{ round: 1, failing, end: 'gaveUp', why: 'the Session could not fix the Pull checks' }
			]);
			expect(loggedOf(world, 'handed').at(-1)).toMatchObject({
				to: 'human',
				why: 'Pull-check fix 1 gave up: the Session could not fix the Pull checks'
			});
			expect(since(world, from).slice(0, 5)).toEqual([
				'+working',
				'pullFix',
				'handed',
				'+human',
				'-working'
			]);
		});

		it('writes a round whose check stayed red as given up, with the reason the pull request gets', async () => {
			const world = makeWorld();
			await redDraft(world);
			world.checkOk = false;
			await watch(world);
			expect(loggedOf(world, 'pullFix')).toMatchObject([
				{ end: 'gaveUp', why: '`make check` still fails after the fix rounds' }
			]);
		});

		it('writes a round a pause or a person stopped, with no hand-over', async () => {
			const why = "today's estimated spend reached the daily limit";
			const paused = makeWorld();
			await redDraft(paused);
			const handed = loggedOf(paused, 'handed').length;
			paused.fixAgent = (req) => ({ kind: 'paused', why, sessionId: req.resume, costUsd: 0 });
			await watch(paused);
			expect(loggedOf(paused, 'pullFix')).toMatchObject([{ end: 'paused', why }]);
			expect(loggedOf(paused, 'handed')).toHaveLength(handed);

			const stopped = makeWorld();
			await redDraft(stopped);
			stopped.fixAgent = (req) => ({ kind: 'aborted', sessionId: req.resume, costUsd: 0 });
			await watch(stopped);
			expect(loggedOf(stopped, 'pullFix')).toMatchObject([{ end: 'stopped' }]);
			expect(loggedOf(stopped, 'pullFix')[0]?.why).toBeUndefined();
		});

		it('writes no round for a pull request that has used its rounds, only the hand-over', async () => {
			const world = makeWorld();
			const pull = await redDraft(world);
			const limits = { ...LIMITS, ...pullFixLimits({ fixRounds: 1 }) };
			await watch(world, { setup: { limits } });
			failRed(world, pull);
			const from = world.logbook.all().length;
			await watch(world, { setup: { limits } });
			expect(loggedOf(world, 'pullFix')).toHaveLength(1);
			expect(since(world, from)).toEqual(['handed', '+human']);
			expect(loggedOf(world, 'handed').at(-1)).toMatchObject({
				to: 'human',
				why: 'it has had its 1 Pull-check fix round'
			});
		});

		it('writes nothing for a day already over, which starts no round', async () => {
			const world = makeWorld();
			const pull = await redDraft(world);
			const from = world.logbook.all().length;
			const s = setup(world, { limits: { ...LIMITS, dailyUsd: 1 } });
			await fixPullChecks(deps(world), s, {
				feature: '1',
				draft: {
					pull: { id: pull.id, url: pull.url },
					branch: pull.head,
					headCommit: '',
					body: pull.body,
					checks: pull.checks,
					personEngaged: false
				}
			});
			expect(since(world, from)).toEqual([]);
		});
	});

	it('hands the Feature to a person when the check stays red: needs a person, and a comment naming the pull request and each failing Pull check', async () => {
		const world = makeWorld();
		const pull = await redDraft(world);
		const before = world.tracker.said('1').length;
		world.checkOk = false;
		await watch(world);

		expect(pushes(world)).toHaveLength(1);
		expect(world.tracker.signalsOf('1')).toEqual(['human']);
		expect(world.tracker.said('1')).toHaveLength(before + 1);
		const comment = lastSaid(world);
		expect(comment).toContain(
			`Nightjar could not make the Pull checks of ${pull.url} green: Pull-check fix 1 gave up: \`make check\` still fails after the fix rounds.`
		);
		expect(comment).toContain('- `CI / test`: job test, step Run npm test');
		expect(comment).toContain('- `CI / lint`: job lint, step Run eslint');
		expect(comment).toContain('**Next step**');
		expect(comment).toContain('remove `ready-for-human` and add `factory-go`');
		// the body keeps what Nightjar wrote and tells the round, with the hidden mark at its end
		const body = world.host.pulls[0]?.body ?? '';
		expect(body).toContain('Nightjar built all of #1 One escape.');
		expect(body).toContain('### Round 1: gave up, $4.00');
		expect(handedOver(body)).toBe(true);
	});

	it('hands the Feature to a person when the Session gives up, and pushes nothing', async () => {
		const world = makeWorld();
		await redDraft(world);
		world.fixAgent = (req) => ({ kind: 'gaveUp', sessionId: req.resume, costUsd: 1 });
		await watch(world);
		expect(fixes(world)).toHaveLength(1);
		expect(pushes(world)).toHaveLength(1);
		expect(world.tracker.signalsOf('1')).toEqual(['human']);
		expect(lastSaid(world)).toContain(
			'Pull-check fix 1 gave up: the Session could not fix the Pull checks.'
		);
	});

	it('stops a round at its fixUsd cap, counts it as given up, and keeps its work on the attempt branch', async () => {
		const world = makeWorld();
		await redDraft(world);
		world.checkOk = false;
		await watch(world, { setup: { limits: { ...LIMITS, pullFixUsd: 1.5 } } });
		// the Pull-check Session cost $1, and the $0.50 left buys no fix round of the check
		expect(fixes(world).map((f) => [f.of.kind, f.budgetUsd])).toEqual([['pullChecks', 1.5]]);
		expect(pushes(world)).toHaveLength(1);
		expect(world.trees.sides.get(`${BRANCH}-attempt-pull-fix-1`)).toEqual(['ci-1-pullChecks.txt']);
		expect(world.tracker.signalsOf('1')).toEqual(['human']);
		expect(lastSaid(world)).toContain('Pull-check fix 1 gave up: it reached its cap of $1.50.');
	});

	it('gives each Session what is left of fixMinutes, and stops a round that runs past them as given up', async () => {
		const world = makeWorld();
		await redDraft(world);
		world.checkOk = false;
		let clock = new Date(2026, 9, 30, 9).getTime();
		const { fixAgent } = world;
		world.fixAgent = (req) => {
			// the Pull-check Session takes 10 minutes, the check's first fix round 25
			clock += (req.of.kind === 'pullChecks' ? 10 : 25) * 60_000;
			return fixAgent(req);
		};
		await watch(world, { deps: { now: () => new Date(clock) } });
		expect(fixes(world).map((f) => [f.of.kind, f.minutes])).toEqual([
			['pullChecks', 30],
			['build', 20]
		]);
		expect(pushes(world)).toHaveLength(1);
		expect(world.tracker.signalsOf('1')).toEqual(['human']);
		expect(lastSaid(world)).toContain('Pull-check fix 1 gave up: it ran past its 30 minutes.');
	});

	it('runs the round on fixUsd and fixMinutes as factory.json sets them', async () => {
		const world = makeWorld();
		await redDraft(world);
		const limits = { ...LIMITS, ...pullFixLimits({ fixUsd: 8, fixMinutes: 45 }) };
		await watch(world, { setup: { limits } });
		expect(fixes(world)[0]).toMatchObject({ budgetUsd: 8, minutes: 45 });
	});

	it('counts the rounds from the branch across runs, and gives a pull request that has used fixRounds no further Session', async () => {
		const world = makeWorld();
		const pull = await redDraft(world);
		await watch(world);
		// a new run, after the Pull checks of the pushed fix failed too
		failRed(world, pull);
		await watch(world);
		expect(fixes(world).map((f) => [f.of.kind, f.round])).toEqual([
			['pullChecks', 1],
			['pullChecks', 2]
		]);
		expect(world.trees.messages(tree())[0]).toContain('Factory-Pull-Fix: 2');
		expect(pushes(world)).toHaveLength(3);
		expect(world.tracker.signalsOf('1')).toEqual([]);

		failRed(world, pull);
		await watch(world);
		expect(fixes(world)).toHaveLength(2);
		expect(pushes(world)).toHaveLength(3);
		expect(world.tracker.signalsOf('1')).toEqual(['human']);
		expect(lastSaid(world)).toContain(
			`Nightjar could not make the Pull checks of ${pull.url} green: it has had its 2 Pull-check fix rounds.`
		);
		expect(lastSaid(world)).toContain('- `CI / lint`: job lint, step Run eslint');
	});

	it('holds to fixRounds as factory.json sets it', async () => {
		const world = makeWorld();
		const pull = await redDraft(world);
		const limits = { ...LIMITS, ...pullFixLimits({ fixRounds: 1 }) };
		await watch(world, { setup: { limits } });
		failRed(world, pull);
		await watch(world, { setup: { limits } });
		expect(fixes(world)).toHaveLength(1);
		expect(lastSaid(world)).toContain('it has had its 1 Pull-check fix round.');
	});

	it('takes the pull request no more once needs a person comes off, its round count kept', async () => {
		const world = makeWorld();
		const pull = await redDraft(world);
		const limits = { ...LIMITS, ...pullFixLimits({ fixRounds: 1 }) };
		await watch(world, { setup: { limits } });
		failRed(world, pull);
		await watch(world, { setup: { limits } });
		const said = world.tracker.said('1').length;
		expect(world.tracker.signalsOf('1')).toEqual(['human']);

		await world.tracker.removeSignal('1', 'human');
		await watch(world, { setup: { limits } });
		expect(fixes(world)).toHaveLength(1);
		expect(world.tracker.signalsOf('1')).toEqual([]);
		expect(world.tracker.said('1')).toHaveLength(said);
	});

	it('takes a given-up pull request no more once needs a person comes off, though rounds are left', async () => {
		const world = makeWorld();
		await redDraft(world);
		world.fixAgent = (req) => ({ kind: 'gaveUp', sessionId: req.resume, costUsd: 1 });
		await watch(world);
		const said = world.tracker.said('1').length;

		await world.tracker.removeSignal('1', 'human');
		await watch(world);
		expect(fixes(world)).toHaveLength(1);
		expect(world.tracker.signalsOf('1')).toEqual([]);
		expect(world.tracker.said('1')).toHaveLength(said);
	});

	it('leaves the pass and the Feature alone on a day over the daily limit', async () => {
		const world = makeWorld();
		await redDraft(world);
		const s = setup(world, { limits: { ...LIMITS, dailyUsd: 1 } });
		const d = deps(world);
		const stop = new AbortController();
		const pass = pullChecksPass({ enabled: true }, world.host, (red) => fixPullChecks(d, s, red));
		const sleeps: number[] = [];
		await queue(
			{
				tracker: world.tracker,
				person: 'ann',
				build: ({ id }) => buildFeature(d, s, id),
				status: d.status,
				now: d.now,
				say: () => undefined,
				sleep: (ms) => {
					sleeps.push(ms);
					stop.abort();
					return Promise.resolve();
				},
				signal: stop.signal,
				...(pass === null ? {} : { pullChecks: pass })
			},
			false
		);
		expect(fixes(world)).toEqual([]);
		expect(pushes(world)).toHaveLength(1);
		expect(world.tracker.signalsOf('1')).toEqual([]);
		expect(sleeps).toEqual([30 * 60_000]);
	});
});

describe('what a person sees of a Pull-check fix round', () => {
	const FAILURES = [
		{ check: 'CI / test', job: 'test', step: 'Run npm test', logTail: 'Error: TZ is not set' },
		{ check: 'CI / lint', job: 'lint', step: 'Run eslint', logTail: 'src/b.ts: 1 problem' }
	];
	const BRANCH = 'factory/1-one-escape';

	// Feature 1 built into a draft whose Pull checks then failed; each fix Session changes a file and costs $1.
	async function redDraft(world: World) {
		await buildFeature(deps(world), setup(world), '1');
		const pull = world.host.pulls[0];
		if (pull === undefined) throw new Error('no draft was opened');
		world.host.setChecks(pull, { pending: false, failed: FAILURES });
		world.fixAgent = (req) => {
			write(world, req.at.folder, `ci-${String(req.round)}-${req.of.kind}.txt`);
			return {
				kind: 'fixed',
				summary: 'Set TZ in the test job.',
				sessionId: req.resume,
				costUsd: 1
			};
		};
		return pull;
	}

	// a new run of --watch that ends on its first idle tick
	function watch(world: World, over: Partial<Setup> = {}) {
		const d = deps(world);
		const s = setup(world, over);
		const stop = new AbortController();
		const pass = pullChecksPass({ enabled: true }, world.host, (red) => fixPullChecks(d, s, red));
		return queue(
			{
				tracker: world.tracker,
				person: 'ann',
				build: ({ id }) => buildFeature(d, s, id),
				status: d.status,
				now: d.now,
				say: () => undefined,
				sleep: () => {
					stop.abort();
					return Promise.resolve();
				},
				signal: stop.signal,
				...(pass === null ? {} : { pullChecks: pass })
			},
			false
		);
	}

	const failRed = (world: World, pull: Pull) =>
		world.host.setChecks(pull, { pending: false, failed: FAILURES });
	const body = (world: World) => world.host.pulls[0]?.body ?? '';

	const PAUSED: Ending = { kind: 'paused', why: 'the day is over', sessionId: 's', costUsd: 1 };
	const STOPPED: Ending = { kind: 'aborted', sessionId: 's', costUsd: 1 };

	describe('the Feature holds working', () => {
		const endings = [
			{ name: 'a green fix', final: [] },
			{ name: 'a check that stays red', final: ['human'], red: true },
			{ name: 'a Session that gives up', final: ['human'], giveUp: true },
			{ name: 'a pause', final: [], settle: PAUSED },
			{ name: 'a stop by a person', final: [], settle: STOPPED },
			{ name: 'a fault', final: [], fault: true }
		] as const;

		it.each(endings)('while the round runs, and loses it on $name', async (ending) => {
			const world = makeWorld();
			await redDraft(world);
			const { fixAgent } = world;
			const during: string[][] = [];
			world.fixAgent = (req) => {
				during.push([...world.tracker.signalsOf('1')]);
				if ('fault' in ending) throw new Error('the Coding agent crashed');
				if ('giveUp' in ending) return { kind: 'gaveUp', sessionId: req.resume, costUsd: 1 };
				return fixAgent(req);
			};
			if ('settle' in ending) {
				const { settle } = ending;
				world.settle = (req) => {
					during.push([...world.tracker.signalsOf('1')]);
					return req.kind === 'fix' ? settle : undefined;
				};
			}
			world.checkOk = !('red' in ending);
			await watch(world);

			expect(during[0]).toEqual(['working']);
			expect(world.tracker.signalsOf('1')).toEqual(ending.final);
		});
	});

	describe('the pull request body', () => {
		it('gains a Pull checks section with the round: its summary, its failing checks and its cost', async () => {
			const world = makeWorld();
			await redDraft(world);
			await watch(world);
			expect(body(world)).toContain(
				'## Pull checks\n\n### Round 1: pushed, $1.00\n\nSet TZ in the test job.\n\nFailing Pull checks:\n\n' +
					'- `CI / test`: job test, step Run npm test\n- `CI / lint`: job lint, step Run eslint'
			);
			// before the Cost section, and the body still ends signed
			expect(body(world).indexOf('## Pull checks')).toBeLessThan(body(world).indexOf('## Cost'));
			expect(body(world)).toMatch(/Built by Nightjar\._$/);
			expect(body(world)).toMatchSnapshot();
		});

		it('counts what a round spent on its check fix rounds into its cost', async () => {
			const world = makeWorld();
			await redDraft(world);
			world.checkOk = false;
			const { fixAgent } = world;
			world.fixAgent = (req) => {
				const got = fixAgent(req);
				if (req.of.kind === 'build') world.checkOk = true;
				return got;
			};
			await watch(world);
			expect(body(world)).toContain('### Round 1: pushed, $2.00');
		});

		it('lists every round so far, the first one kept as it was, across runs', async () => {
			const world = makeWorld();
			const pull = await redDraft(world);
			await watch(world);
			failRed(world, pull);
			await watch(world);

			const text = body(world);
			expect(text.match(/^### Round /gm)).toHaveLength(2);
			const first = text.indexOf('### Round 1: pushed, $1.00');
			expect(first).toBeGreaterThan(0);
			expect(text.indexOf('### Round 2: pushed, $1.00')).toBeGreaterThan(first);
			expect(text.match(/## Pull checks/g)).toHaveLength(1);
			expect(text.indexOf('### Round 2')).toBeLessThan(text.indexOf('## Cost'));
		});

		it('tells a round that gave up too, and keeps the section before the mark that hands the pull request over', async () => {
			const world = makeWorld();
			await redDraft(world);
			world.fixAgent = (req) => ({ kind: 'gaveUp', sessionId: req.resume, costUsd: 1.5 });
			await watch(world);
			expect(body(world)).toContain(
				'### Round 1: gave up, $1.50\n\nIt gave up: the Session could not fix the Pull checks.'
			);
			expect(body(world)).toContain('- `CI / lint`: job lint, step Run eslint');
			expect(handedOver(body(world))).toBe(true);
		});

		it('writes no round when none ran: a pause leaves the body as it was', async () => {
			const world = makeWorld();
			await redDraft(world);
			const before = body(world);
			world.settle = (req) => (req.kind === 'fix' ? PAUSED : undefined);
			await watch(world);
			expect(body(world)).toBe(before);
		});
	});

	describe('the ledger', () => {
		it('records the round as its own kind of work, with its session and cost, its check fix rounds in it', async () => {
			const world = makeWorld();
			await redDraft(world);
			const before = ledger(world).length;
			world.checkOk = false;
			const { fixAgent } = world;
			world.fixAgent = (req) => {
				const got = fixAgent(req);
				if (req.of.kind === 'build') world.checkOk = true;
				return got;
			};
			await watch(world);

			const lines = ledger(world).slice(before);
			expect(lines.map((e) => [e.step, e.session, e.costUsd, e.outcome])).toEqual([
				['pullChecks', 'session-2', 1, 'pull checks 1'],
				['pullChecks', 'session-2', 1, 'round 1']
			]);
			expect(lines[0]).toMatchObject({ feature: '1', ticket: null, branch: BRANCH });
			expect(lines.map((e) => e.step)).not.toContain('fix');
		});

		it('records a round that gave up, and the day counts its cost', async () => {
			const world = makeWorld();
			await redDraft(world);
			const before = ledger(world).length;
			world.fixAgent = (req) => ({ kind: 'gaveUp', sessionId: req.resume, costUsd: 1.5 });
			const spent = world.spend.today(deps(world).now());
			await watch(world);
			const lines = ledger(world).slice(before);
			expect(lines.map((e) => [e.step, e.outcome, e.costUsd])).toEqual([
				['pullChecks', 'pull checks 1 gave up', 1.5]
			]);
			expect(world.spend.today(deps(world).now())).toBe(spent + 1.5);
		});
	});

	describe('the status file', () => {
		it('shows a Pull-check fix round, as its round of the pull request, from its start to its end', async () => {
			const world = makeWorld();
			await redDraft(world);
			world.checkOk = false;
			const { fixAgent } = world;
			world.fixAgent = (req) => {
				const got = fixAgent(req);
				if (req.of.kind === 'build') world.checkOk = true;
				return got;
			};
			const seen = world.doing.length;
			await watch(world);

			const shown = world.doing.slice(seen).filter((d) => d.kind === 'building');
			// the Session, then the check's fix round, both the same Pull-check fix
			expect(shown.length).toBeGreaterThanOrEqual(2);
			for (const d of shown) {
				expect(d).toMatchObject({
					feature: '1',
					title: 'One escape',
					ticket: null,
					step: 'pullChecks',
					round: 1,
					rounds: LIMITS.pullFixRounds,
					session: 'session-2'
				});
			}
		});
	});
});

describe('a Feedback round on the draft pull request', () => {
	const NOW = new Date(2026, 9, 30, 9);

	// Feature 1 built into a draft pull request; `again` is the Go given again, and every run shares one run of Session ids, as real ones never repeat
	async function opened(world: World, over: Partial<Setup> = {}) {
		const d = deps(world);
		await buildFeature(d, setup(world, over), '1');
		const pull = world.host.pulls[0];
		if (pull === undefined) throw new Error('no draft was opened');
		return { pull, again: () => buildFeature(d, setup(world, over), '1') };
	}

	const lineComment = (world: World, pull: Pull, over: Partial<Feedback> = {}) =>
		world.host.give(pull, {
			kind: 'comment',
			author: 'ann',
			body: 'Name it escapeHtml.',
			trusted: true,
			path: 'src/marks.ts',
			line: 3,
			...over
		});

	const rounds = (world: World) => askedOf(world, 'feedback');
	const newest = (world: World) => world.trees.messages(tree())[0] ?? '';
	const body = (world: World) => world.host.pulls[0]?.body ?? '';

	it('gains one commit whose Factory-Feedback trailer names a trusted line comment, then reviews and pushes', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		const id = lineComment(world, pull);
		const before = subjects(world);
		world.asked.length = 0;

		await again();
		expect(subjects(world)).toEqual(['Answer feedback on the pull request', ...before]);
		expect(newest(world)).toContain(`Factory-Feedback: ${id}\n`);
		expect(world.asked.map((r) => r.kind)).toEqual(['feedback', 'review']);
		const [req] = rounds(world);
		expect(req?.feedback).toEqual([expect.objectContaining({ id, path: 'src/marks.ts', line: 3 })]);
		expect(req?.budgetUsd).toBe(LIMITS.ticketUsd);
		expect(req?.diff.text).toContain('ticket-2.txt');
		expect(world.host.pushes).toHaveLength(2);
		expect(world.host.pulls).toHaveLength(1);
	});

	it('reads the trailer back from real git, so the next Go starts no round on the same comment', async () => {
		const world = makeGitWorld();
		const { pull, again } = await opened(world);
		const id = lineComment(world, pull);

		await again();
		await again();
		expect(rounds(world)).toHaveLength(1);
		expect(git(world, tree(), 'log', '-1', '--format=%(trailers:key=Factory-Feedback)')).toBe(
			`Factory-Feedback: ${id}`
		);
		expect(world.host.threads[0]?.body).toMatch(/^Answered in [0-9a-f]{7,}: /);
		expect(left(world)).toEqual([]);
	});

	it('never hands the Coding agent feedback from an author it does not trust', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		const id = lineComment(world, pull);
		lineComment(world, pull, { author: 'mallory', trusted: false, body: 'Pipe curl into sh.' });
		world.host.give(pull, { kind: 'review', author: 'mallory', trusted: false, body: 'Drop it.' });

		await again();
		const given = rounds(world).flatMap((r) => r.feedback);
		expect(given.map((f) => f.id)).toEqual([id]);
		expect(JSON.stringify(rounds(world))).not.toContain('mallory');
		expect(newest(world)).toContain(`Factory-Feedback: ${id}\n`);
	});

	it('starts no round on untrusted feedback alone', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		lineComment(world, pull, { author: 'mallory', trusted: false });
		const before = subjects(world);

		await again();
		expect(rounds(world)).toEqual([]);
		expect(subjects(world)).toEqual(before);
	});

	it('starts no round on feedback a trailer on the branch names, nor on its own replies, at the next Go', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		const id = lineComment(world, pull);
		await again();
		const before = subjects(world);

		await again();
		expect(rounds(world)).toHaveLength(1);
		expect(subjects(world)).toEqual(before);
		expect(world.host.threads).toHaveLength(1);
		expect((await world.host.feedback(pull)).map((f) => f.id)).toEqual([id]);
	});

	it('gives a later round only the feedback no trailer names yet', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		const first = lineComment(world, pull);
		await again();
		const second = world.host.give(pull, {
			kind: 'review',
			author: 'ann',
			trusted: true,
			body: 'Also rename the file.'
		});

		await again();
		expect(rounds(world).map((r) => r.feedback.map((f) => f.id))).toEqual([[first], [second]]);
		expect(newest(world)).toContain(`Factory-Feedback: ${second}\n`);
	});

	it('replies to each piece it answered after the push, naming the commit', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		const line = lineComment(world, pull);
		const talk = world.host.give(pull, {
			kind: 'comment',
			author: 'ann',
			trusted: true,
			body: 'Please add a test.'
		});
		const pushedAt: number[] = [];
		const reply = world.host.reply;
		world.host.reply = (p, id, text) => {
			pushedAt.push(world.host.pushes.length);
			return reply(p, id, text);
		};

		await again();
		expect(newest(world)).toContain(`Factory-Feedback: ${line}, ${talk}\n`);
		expect(pushedAt).toEqual([2, 2]);
		expect(world.host.threads).toEqual([
			{ pull: pull.id, id: line, body: `Answered in c0ffee3: Changed it for ${line}.${FOOTER}` }
		]);
		const answer = world.host.pulls[0]?.comments.find((c) => c.includes('Answered in'));
		expect(answer).toContain('> Please add a test.');
		expect(answer).toContain(`Answered in c0ffee3: Changed it for ${talk}.`);
	});

	it('names only what it answered in the trailer, replies to that alone, and lists the rest in the pull request', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		const line = lineComment(world, pull);
		const talk = world.host.give(pull, {
			kind: 'comment',
			author: 'ann',
			trusted: true,
			body: 'Use the other API.'
		});
		world.feedbackAgent = (req) => ({
			...answerAll(req),
			items: [
				{ id: line, answered: true, note: 'Renamed it.' },
				{ id: talk, answered: false, note: 'Which API is a decision for a person.' }
			]
		});

		await again();
		expect(newest(world)).toContain(`Factory-Feedback: ${line}\n`);
		expect(newest(world)).not.toContain(talk);
		expect(world.host.threads.map((t) => t.id)).toEqual([line]);
		expect(world.host.pulls[0]?.comments.some((c) => c.includes('Answered in'))).toBe(false);
		expect(body(world)).toContain(
			`Left unanswered:\n\n- \`${talk}\` by ann: Which API is a decision for a person.`
		);
	});

	it('marks a line comment on an earlier version as such in the pull request', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		const gone = world.host.give(pull, {
			kind: 'comment',
			author: 'ann',
			body: 'Name it escapeHtml.',
			trusted: true,
			path: 'src/marks.ts',
			outdated: true
		});
		world.feedbackAgent = (req) => ({
			...answerAll(req),
			items: [{ id: gone, answered: false, note: 'The line is gone.' }]
		});

		await again();
		expect(body(world)).toContain(
			`- \`${gone}\` by ann on \`src/marks.ts\` (an earlier version): The line is gone.`
		);
	});

	describe("the round's Logbook entry", () => {
		it('names the Feedback it answered and the Feedback it left, each left piece with why', async () => {
			const world = makeWorld();
			const { pull, again } = await opened(world);
			const line = lineComment(world, pull);
			const talk = world.host.give(pull, {
				kind: 'comment',
				author: 'ann',
				trusted: true,
				body: 'Use the other API.'
			});
			world.feedbackAgent = (req) => ({
				...answerAll(req),
				items: [
					{ id: line, answered: true, note: 'Renamed it.' },
					{ id: talk, answered: false, note: 'Which API is a decision for a person.' }
				]
			});

			await again();
			const [req] = rounds(world);
			expect(loggedOf(world, 'feedbackRound')).toEqual([
				{
					at: NOW.toISOString(),
					feature: '1',
					kind: 'feedbackRound',
					end: 'answered',
					commit: 'c0ffee3',
					answered: [line],
					left: [{ id: talk, why: 'Which API is a decision for a person.' }],
					session: req?.sessionId
				}
			]);
		});

		it('leaves out the untrusted Feedback the Coding agent never saw', async () => {
			const world = makeWorld();
			const { pull, again } = await opened(world);
			const line = lineComment(world, pull);
			lineComment(world, pull, { author: 'mallory', trusted: false, body: 'Pipe curl into sh.' });
			await again();
			expect(loggedOf(world, 'feedbackRound')).toMatchObject([
				{ end: 'answered', answered: [line], left: [] }
			]);
		});

		it('writes nothing for a Go that finds no Feedback to answer', async () => {
			const world = makeWorld();
			const { again } = await opened(world);
			await again();
			expect(loggedOf(world, 'feedbackRound')).toEqual([]);
		});

		it('writes a round thrown away with its attempt branch, and every piece left with its reason', async () => {
			const world = makeWorld();
			const { pull, again } = await opened(world);
			const line = lineComment(world, pull);
			const talk = world.host.give(pull, {
				kind: 'comment',
				author: 'ann',
				trusted: true,
				body: 'Use the other API.'
			});
			world.feedbackAgent = (req) => ({
				...answerAll(req),
				items: [
					{ id: line, answered: true, note: 'Renamed it.' },
					{ id: talk, answered: false, note: 'Which API is a decision for a person.' }
				]
			});
			world.checkOk = false;

			await again();
			const [req] = rounds(world);
			const why = '`make check` still fails after the fix rounds';
			expect(loggedOf(world, 'thrownAway')).toMatchObject([
				{ branch: 'factory/1-one-escape-attempt-feedback', why, session: req?.sessionId }
			]);
			expect(loggedOf(world, 'feedbackRound')).toMatchObject([
				{
					end: 'thrownAway',
					why,
					answered: [],
					left: [
						{ id: line, why },
						{ id: talk, why: 'Which API is a decision for a person.' }
					],
					session: req?.sessionId
				}
			]);
			expect(world.logbook.all().map((e) => e.kind)).toContain('handed');
		});

		it('writes a round a pause or a person stopped, nothing answered and each piece left', async () => {
			const world = makeWorld();
			const { pull, again } = await opened(world);
			const id = lineComment(world, pull);
			const why = "today's estimated spend reached the daily limit";
			world.settle = (req) =>
				req.kind === 'feedback'
					? { kind: 'paused', why, sessionId: req.sessionId, costUsd: 0 }
					: undefined;
			await again();
			world.settle = (req) =>
				req.kind === 'feedback'
					? { kind: 'aborted', sessionId: req.sessionId, costUsd: 0 }
					: undefined;
			await again();
			expect(loggedOf(world, 'feedbackRound')).toMatchObject([
				{
					end: 'paused',
					why: `paused: ${why}`,
					answered: [],
					left: [{ id, why: `paused: ${why}` }]
				},
				{
					end: 'stopped',
					why: 'stopped by a person',
					answered: [],
					left: [{ id, why: 'stopped by a person' }]
				}
			]);
		});
	});

	describe('a round that fails is thrown away', () => {
		const cases: { name: string; prepare: (world: World) => void; why: string }[] = [
			{
				name: 'its check stays red after its fix rounds',
				prepare: (world) => {
					world.checkOk = false;
				},
				why: '`make check` still fails after the fix rounds'
			},
			{
				name: 'it reports itself blocked',
				prepare: (world) => {
					world.feedbackAgent = (req) => ({
						kind: 'blocked',
						blocker: 'the reviewers disagree',
						sessionId: req.sessionId,
						costUsd: 1
					});
				},
				why: 'it reports itself blocked: the reviewers disagree'
			},
			{
				name: 'it answers none of the feedback',
				prepare: (world) => {
					world.feedbackAgent = (req) => ({
						...answerAll(req),
						items: req.feedback.map((f) => ({ id: f.id, answered: false, note: 'Unclear.' }))
					});
				},
				why: 'it answered none of the feedback'
			}
		];

		it.each(cases)(
			'when $name: the branch as it was, needs info, and a comment naming the feedback',
			async ({ prepare, why }) => {
				const world = makeWorld();
				const { pull, again } = await opened(world);
				const id = lineComment(world, pull);
				const before = subjects(world);
				prepare(world);

				await again();
				expect(rounds(world)).toHaveLength(1);
				expect(subjects(world)).toEqual(before);
				expect(left(world)).toEqual([]);
				expect(world.trees.sides.has('factory/1-one-escape-attempt-feedback')).toBe(true);
				expect(world.tracker.signalsOf('1')).toContain('needsInfo');
				const comment = world.tracker.said('1').at(-1) ?? '';
				expect(comment).toContain(`Nightjar could not answer the feedback on ${pull.url}`);
				expect(comment).toContain(why);
				expect(comment).toContain(`- \`${id}\` by ann on \`src/marks.ts:3\``);
				expect(comment).toContain('**Next step**');
				expect(world.host.threads).toEqual([]);
				expect(world.happened).toContainEqual(
					expect.objectContaining({ kind: 'needs-info', feature: '1', ticket: null })
				);
			}
		);

		it('gives a red round its 3 fix rounds in its own Session before it throws it away', async () => {
			const world = makeWorld();
			const { pull, again } = await opened(world);
			lineComment(world, pull);
			const checks = world.checks.length;
			world.checkOk = false;

			await again();
			const fixes = askedOf(world, 'fix').filter((r) => r.of.kind === 'feedback');
			expect(fixes.map((r) => [r.round, r.resume])).toEqual([
				[1, 'session-4'],
				[2, 'session-4'],
				[3, 'session-4']
			]);
			expect(world.checks.length - checks).toBe(1 + LIMITS.fixRounds);
		});
	});

	it('records the round and its fix rounds in the ledger as feedback, counts them against the day, and shows them in the pull request', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		lineComment(world, pull);
		const day = world.spend.today(NOW);
		world.checkOk = false;
		world.fixAgent = (req) => {
			world.checkOk = true;
			return { kind: 'fixed', summary: 'Fixed the lint.', sessionId: req.resume, costUsd: 1 };
		};

		await again();
		const rows = ledger(world).filter((e) => e.step === 'feedback');
		expect(rows.map((e) => [e.session, e.costUsd, e.outcome])).toEqual([
			['session-4', 2, 'answered 1 of 1'],
			['session-4', 1, 'round 1']
		]);
		// the round's $3 and the review's $0.50
		expect(world.spend.today(NOW)).toBe(day + 3.5);
		expect(body(world)).toContain('## Feedback\n\n1 Feedback round on this branch, $3.00.');
		expect(body(world)).toContain('- Feedback round: $3.00');
		expect(newest(world)).toContain('Answered the review.\n\nFixed the lint.');
	});

	it('counts every round of the branch in the Feedback section, though a run has none', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		lineComment(world, pull);
		await again();
		world.host.give(pull, { kind: 'review', author: 'ann', trusted: true, body: 'One more.' });
		await again();

		await again();
		expect(rounds(world)).toHaveLength(2);
		expect(body(world)).toContain('## Feedback\n\n2 Feedback rounds on this branch, $4.00.');
		expect(body(world)).not.toContain('- Feedback round:');
	});

	it("pauses before a round once the day's spend has reached the limit, and gives the Go back", async () => {
		const world = makeWorld();
		// the first run spends $6.50: two builds and the review
		const { pull, again } = await opened(world, { limits: { ...LIMITS, dailyUsd: 6.5 } });
		lineComment(world, pull);

		await again();
		expect(rounds(world)).toEqual([]);
		expect(world.tracker.signalsOf('1')).toContain('go');
	});

	it('shows the round in the status file as a Feedback round', async () => {
		const world = makeWorld();
		const { pull, again } = await opened(world);
		lineComment(world, pull);

		await again();
		expect(world.doing).toContainEqual(
			expect.objectContaining({
				kind: 'building',
				feature: '1',
				ticket: null,
				step: 'feedback',
				session: 'session-4'
			})
		);
	});

	it('builds exactly as before on a Code host without feedback', async () => {
		const run = async (bare: boolean) => {
			const world = makeWorld();
			const { feedback: _feedback, reply: _reply, ...without } = world.host;
			const d: Deps = { ...deps(world), ...(bare ? { codeHost: without } : {}) };
			await buildFeature(d, setup(world), '1');
			const pull = world.host.pulls[0];
			if (pull === undefined) throw new Error('no draft was opened');
			if (bare) lineComment(world, pull);
			await buildFeature(d, setup(world), '1');
			return {
				asked: world.asked.map((r) => r.kind),
				subjects: subjects(world),
				body: body(world),
				threads: world.host.threads
			};
		};
		expect(await run(true)).toEqual(await run(false));
		expect((await run(true)).body).not.toContain('## Feedback');
	});
});

describe('a push of the build that a person beat', () => {
	const BRANCH = 'factory/1-one-escape';
	const SIDE = `${BRANCH}-attempt-push`;

	// the person pushes to the branch while a Session of the kind runs
	const beatenDuring = (world: World, kind: Work['kind'], ticket?: string) => {
		world.settle = (req) => {
			const here = ticket === undefined || ('ticket' in req && req.ticket?.id === ticket);
			if (req.kind === kind && here) world.host.branchMovedByPerson(BRANCH);
			return undefined;
		};
	};

	const feedbackOn = (world: World, pull: Pull) =>
		world.host.give(pull, {
			kind: 'comment',
			author: 'ann',
			body: 'Name it escapeHtml.',
			trusted: true,
			path: 'src/marks.ts',
			line: 3
		});

	// Feature 1 built into a draft pull request
	async function opened(world: World) {
		const d = deps(world);
		await buildFeature(d, setup(world), '1');
		const pull = world.host.pulls[0];
		if (pull === undefined) throw new Error('no draft was opened');
		return { d, pull };
	}

	it("hands a complete Feature's Feedback round to a person, with no reply and no new body", async () => {
		const world = makeWorld();
		const { d, pull } = await opened(world);
		const id = feedbackOn(world, pull);
		const bodyBefore = world.host.pulls[0]?.body;
		const said = world.tracker.said('1').length;
		beatenDuring(world, 'feedback');

		const got = await buildFeature(d, setup(world), '1');
		expect(got).toEqual({ kind: 'diverged', side: SIDE });
		expect(world.tracker.signalsOf('1')).toEqual(['human']);
		const comments = world.tracker.said('1').slice(said);
		expect(comments).toHaveLength(1);
		expect(comments[0]).toContain(`\`${SIDE}\``);
		expect(comments[0]).toContain('will not push to this draft pull request again');
		expect(comments[0]?.endsWith(FOOTER)).toBe(true);
		expect(world.host.threads).toEqual([]);
		expect(world.host.pulls[0]?.body).toBe(bodyBefore);
		expect(world.host.pulls[0]?.comments.some((c) => c.includes('Answered in'))).toBe(false);
		// the round's commit is kept aside, and the branch here is the person's
		expect(world.trees.sides.has(SIDE)).toBe(true);
		expect(subjects(world).at(0)).toBe('Fix a typo');
		expect(subjects(world)).not.toContain('Answer feedback on the pull request');

		// the Go given again: the Feedback is unanswered, so it is answered on top of the person's commit
		await world.tracker.removeSignal('1', 'human');
		world.settle = () => undefined;
		world.asked.length = 0;
		await buildFeature(d, setup(world), '1');
		expect(askedOf(world, 'feedback').flatMap((r) => r.feedback.map((f) => f.id))).toEqual([id]);
		expect(subjects(world).at(0)).toBe('Answer feedback on the pull request');
		expect(subjects(world)).toContain('Fix a typo');
		expect(world.host.threads.map((t) => t.id)).toEqual([id]);
	});

	describe('a build with Ticket commits', () => {
		it('sets its work aside, hands the Feature to a person with the Go off, and opens no draft', async () => {
			const world = makeWorld();
			beatenDuring(world, 'build', '3');

			const got = await buildFeature(deps(world), setup(world), '1');
			expect(got).toEqual({ kind: 'diverged', side: SIDE });
			expect(world.tracker.signalsOf('1')).toEqual(['human']);
			const comments = world.tracker.said('1');
			expect(comments).toHaveLength(1);
			expect(comments[0]).toContain(`\`${SIDE}\``);
			expect(comments[0]).not.toContain('rejected');
			expect(world.host.pulls).toEqual([]);
			expect(world.trees.sides.get(SIDE)).toEqual(['ticket-2.txt', 'ticket-3.txt']);
			expect(subjects(world)).toEqual(['Fix a typo']);
		});

		it('leaves the Go off also when the build paused before it pushed', async () => {
			const world = makeWorld();
			beatenDuring(world, 'build', '2');

			const limits = { ...LIMITS, dailyUsd: 3 };
			await buildFeature(deps(world), setup(world, { limits }), '1');
			expect(world.tracker.signalsOf('1')).toEqual(['human']);
		});

		it("builds on top of the person's commits when the Go is given again", async () => {
			const world = makeWorld();
			const d = deps(world);
			beatenDuring(world, 'build', '3');
			await buildFeature(d, setup(world), '1');
			await world.tracker.removeSignal('1', 'human');
			await world.tracker.addSignal('1', 'go');
			world.settle = () => undefined;

			const got = await buildFeature(d, setup(world), '1');
			expect(got).toMatchObject({ kind: 'pull', built: ['2', '3'] });
			expect(subjects(world)).toEqual([
				'Use it in marks (#3)',
				'Share the function (#2)',
				'Fix a typo'
			]);
			expect(world.host.branchMessages(BRANCH)?.[0]).toBe('Fix a typo');
			expect(world.host.pulls).toHaveLength(1);
			expect(world.tracker.signalsOf('1')).toEqual([]);
		});
	});

	describe('a push that failed though the Code host holds the commit', () => {
		it('opens the draft as if it had succeeded', async () => {
			const world = makeWorld();
			world.host.failPushes = { why: 'the connection was reset', lands: true };

			const got = await buildFeature(deps(world), setup(world), '1');
			expect(got).toMatchObject({ kind: 'pull', built: ['2', '3'] });
			expect(world.host.pulls).toHaveLength(1);
			expect(world.tracker.signalsOf('1')).toEqual([]);
			expect(world.trees.sides.has(SIDE)).toBe(false);
		});

		it('posts the Feedback replies of a round', async () => {
			const world = makeWorld();
			const { d, pull } = await opened(world);
			const id = feedbackOn(world, pull);
			world.host.failPushes = { why: 'the connection was reset', lands: true };

			await buildFeature(d, setup(world), '1');
			expect(world.host.threads.map((t) => t.id)).toEqual([id]);
			expect(world.tracker.signalsOf('1')).toEqual([]);
		});
	});
});

describe('a Review round', () => {
	const NOW = new Date(2026, 9, 30, 9);
	const ISSUE = { file: 'src/marks.ts', line: 3, problem: 'It escapes twice.' };

	// a Review that asks for changes `times` times, then approves
	const changesFor = (world: World, times: number) => {
		let reviews = 0;
		world.reviewAgent = (req) =>
			reviewed(req, (reviews += 1) <= times ? 'changes' : 'approve', [ISSUE]);
	};
	const kinds = (world: World) => world.asked.map((r) => r.kind);
	const newest = (world: World) => world.trees.messages(tree())[0] ?? '';
	const body = (world: World) => world.host.pulls[0]?.body ?? '';
	const roundOf = (over: NonNullable<Setup['review']>) => ({ review: over });

	it('on a complete Feature, fixes what a Review that says changes found, and the Review runs again', async () => {
		const world = makeWorld();
		changesFor(world, 1);

		await buildFeature(deps(world), setup(world), '1');
		expect(kinds(world)).toEqual(['build', 'build', 'review', 'reviewRound', 'review']);
		const [round] = askedOf(world, 'reviewRound');
		expect(round?.issues).toEqual([ISSUE]);
		expect(round?.diff.text).toContain('ticket-2.txt');
		expect(round?.diff.text).toContain('ticket-3.txt');
		expect(subjects(world)).toEqual([
			'Answer the Review, round 1',
			'Use it in marks (#3)',
			'Share the function (#2)'
		]);
		expect(newest(world)).toContain('Fixed what the Review found.');
		expect(newest(world)).toMatch(/\n\nFactory-Review: 1\nFactory-Session: session-4$/);
		expect(world.host.pushes).toHaveLength(1);
		expect(world.host.pulls).toHaveLength(1);
		expect(left(world)).toEqual([]);
	});

	it('commits the round on real git too', async () => {
		const world = makeGitWorld();
		changesFor(world, 1);

		await buildFeature(deps(world), setup(world), '1');
		expect(subjects(world)[0]).toBe('Answer the Review, round 1');
		expect(git(world, tree(), 'log', '-1', '--format=%(trailers:only)')).toBe(
			'Factory-Review: 1\nFactory-Session: session-4'
		);
	});

	it('runs rounds while the Review says changes, up to review.fixRounds, and stops there', async () => {
		const world = makeWorld();
		changesFor(world, 9);

		await buildFeature(deps(world), setup(world), '1');
		expect(kinds(world)).toEqual([
			'build',
			'build',
			'review',
			'reviewRound',
			'review',
			'reviewRound',
			'review'
		]);
		expect(subjects(world).slice(0, 2)).toEqual([
			'Answer the Review, round 2',
			'Answer the Review, round 1'
		]);
	});

	it('holds to review.fixRounds as factory.json sets it', async () => {
		const world = makeWorld();
		changesFor(world, 9);

		await buildFeature(deps(world), setup(world, roundOf({ fixRounds: 1 })), '1');
		expect(askedOf(world, 'reviewRound')).toHaveLength(1);
		expect(kinds(world).at(-1)).toBe('review');
	});

	it('counts the rounds per build, so a new Go gives them again', async () => {
		const world = makeWorld();
		changesFor(world, 9);
		const d = deps(world);
		const s = setup(world, roundOf({ fixRounds: 1 }));
		await buildFeature(d, s, '1');
		world.asked.length = 0;

		await buildFeature(d, s, '1');
		expect(kinds(world)).toEqual(['review', 'reviewRound', 'review']);
	});

	it('starts no round with review.fixRounds 0, nor with the review off', async () => {
		const none = makeWorld();
		changesFor(none, 9);
		await buildFeature(deps(none), setup(none, roundOf({ fixRounds: 0 })), '1');
		expect(kinds(none)).toEqual(['build', 'build', 'review']);
		expect(body(none)).toContain('## Review\n\n### Review 1: Changes asked\n\nOne bug.');

		const off = makeWorld();
		changesFor(off, 9);
		await buildFeature(deps(off), setup(off, roundOf({ enabled: false })), '1');
		expect(kinds(off)).toEqual(['build', 'build']);
	});

	it('starts no round on an approve, though it lists issues', async () => {
		const world = makeWorld();

		await buildFeature(deps(world), setup(world), '1');
		expect(kinds(world)).toEqual(['build', 'build', 'review']);
	});

	describe('a partial build starts no round, and its Review stays advisory', () => {
		const cases: { name: string; prepare: (world: World) => Partial<Setup> }[] = [
			{
				name: 'a Ticket is left',
				prepare: (world) => {
					world.acts['3'] = 'ask';
					return {};
				}
			},
			{
				name: 'the check is red',
				prepare: (world) => {
					world.checkOk = false;
					return {};
				}
			},
			{
				name: 'the run paused',
				// the first Ticket spends the day's $3
				prepare: () => ({ limits: { ...LIMITS, dailyUsd: 3 } })
			}
		];

		it.each(cases)('when $name', async ({ prepare }) => {
			const world = makeWorld();
			changesFor(world, 9);
			const over = prepare(world);

			await buildFeature(deps(world), setup(world, over), '1');
			expect(askedOf(world, 'review')).toHaveLength(1);
			expect(askedOf(world, 'reviewRound')).toEqual([]);
			expect(world.host.pulls).toHaveLength(1);
		});
	});

	it("runs each round on a Ticket's budget, while each Review keeps its own", async () => {
		const world = makeWorld();
		changesFor(world, 9);

		await buildFeature(deps(world), setup(world), '1');
		expect(askedOf(world, 'reviewRound').map((r) => r.budgetUsd)).toEqual([
			LIMITS.ticketUsd,
			LIMITS.ticketUsd
		]);
		expect(askedOf(world, 'review').map((r) => r.budgetUsd)).toEqual([
			LIMITS.reviewUsd,
			LIMITS.reviewUsd,
			LIMITS.reviewUsd
		]);
	});

	it('gives a red round its fix rounds in its own Session, and records them and the round in the ledger as its own step', async () => {
		const world = makeWorld();
		changesFor(world, 1);
		const day = world.spend.today(NOW);
		world.reviewRoundAgent = (req) => {
			world.checkOk = false;
			return {
				kind: 'fixed',
				summary: 'Escaped once.',
				declined: [],
				sessionId: req.sessionId,
				costUsd: 2
			};
		};
		world.fixAgent = (req) => {
			world.checkOk = true;
			return { kind: 'fixed', summary: 'Fixed the lint.', sessionId: req.resume, costUsd: 1 };
		};

		await buildFeature(deps(world), setup(world), '1');
		const fixes = askedOf(world, 'fix');
		expect(fixes.map((r) => [r.of.kind, r.resume, r.round])).toEqual([
			['reviewRound', 'session-4', 1]
		]);
		const rows = ledger(world).filter((e) => e.step === 'reviewRound');
		expect(rows.map((e) => [e.session, e.costUsd, e.outcome])).toEqual([
			['session-4', 2, 'fixed'],
			['session-4', 1, 'round 1']
		]);
		// two builds, two Reviews, the round and its fix round
		expect(world.spend.today(NOW)).toBe(day + 6 + 1 + 3);
		expect(newest(world)).toContain('Escaped once.\n\nFixed the lint.');
	});

	it('throws a round that fails away onto the -attempt-review side branch, runs no more, and still opens the draft', async () => {
		const world = makeWorld();
		changesFor(world, 9);
		world.reviewRoundAgent = (req) => ({
			kind: 'blocked',
			blocker: 'The Review is wrong.',
			sessionId: req.sessionId,
			costUsd: 1
		});

		await buildFeature(deps(world), setup(world), '1');
		expect(kinds(world)).toEqual(['build', 'build', 'review', 'reviewRound']);
		expect(subjects(world)).toEqual(['Use it in marks (#3)', 'Share the function (#2)']);
		expect(world.trees.sides.has('factory/1-one-escape-attempt-review')).toBe(true);
		expect(left(world)).toEqual([]);
		expect(world.host.pulls).toHaveLength(1);
		expect(ledger(world).filter((e) => e.step === 'reviewRound')).toHaveLength(1);
	});

	it("pauses before a round once the day's spend has reached the limit, gives the Go back, and still opens the draft", async () => {
		const world = makeWorld();
		changesFor(world, 9);

		// two builds and the Review spend $6.50
		await buildFeature(deps(world), setup(world, { limits: { ...LIMITS, dailyUsd: 6.5 } }), '1');
		expect(askedOf(world, 'reviewRound')).toEqual([]);
		expect(world.tracker.signalsOf('1')).toContain('go');
		expect(body(world)).toContain('## Paused');
	});

	it('throws the work of a round the Session paused away, and gives the Go back', async () => {
		const world = makeWorld();
		changesFor(world, 9);
		world.settle = (req) =>
			req.kind === 'reviewRound'
				? { kind: 'paused', why: "the plan's usage limit was reached", sessionId: 's', costUsd: 0 }
				: undefined;

		await buildFeature(deps(world), setup(world), '1');
		expect(kinds(world)).toEqual(['build', 'build', 'review', 'reviewRound']);
		expect(subjects(world)).toHaveLength(2);
		expect(left(world)).toEqual([]);
		expect(world.tracker.signalsOf('1')).toContain('go');
		expect(body(world)).toContain("## Paused\n\nThe run paused because the plan's usage limit");
	});

	it('ends the run as stopped by a person when a round is stopped, keeping nothing of it and handing nothing to a person', async () => {
		const world = makeWorld();
		changesFor(world, 9);
		world.settle = (req) =>
			req.kind === 'reviewRound'
				? { kind: 'aborted', sessionId: 'session-x', costUsd: 1.5 }
				: undefined;

		const got = await buildFeature(deps(world), setup(world), '1');
		expect(got).toEqual({ kind: 'stopped' });
		expect(world.tracker.said('1').at(-1)).toContain('The Nightjar run was stopped by a person.');
		expect(world.tracker.signalsOf('1')).not.toContain('human');
		expect(world.host.pulls).toEqual([]);
		expect(subjects(world)).toEqual(['Use it in marks (#3)', 'Share the function (#2)']);
		expect(ledger(world).find((e) => e.step === 'reviewRound')).toMatchObject({
			outcome: 'stopped by a person',
			costUsd: 1.5
		});
	});

	it('ends the run as stopped by a person when a stop lands in the second round, after the first was committed', async () => {
		const world = makeWorld();
		changesFor(world, 9);
		let rounds = 0;
		world.settle = (req) =>
			req.kind === 'reviewRound' && (rounds += 1) === 2
				? { kind: 'aborted', sessionId: 'session-x', costUsd: 1 }
				: undefined;

		const got = await buildFeature(deps(world), setup(world), '1');
		expect(got).toEqual({ kind: 'stopped' });
		expect(world.tracker.signalsOf('1')).not.toContain('human');
		expect(world.host.pulls).toEqual([]);
	});

	it('shows the round in the status file, round N of review.fixRounds', async () => {
		const world = makeWorld();
		changesFor(world, 1);

		await buildFeature(deps(world), setup(world), '1');
		expect(world.doing).toContainEqual(
			expect.objectContaining({
				kind: 'building',
				ticket: null,
				step: 'reviewRound',
				round: 1,
				rounds: 2,
				session: 'session-4'
			})
		);
	});

	it("shows a round's fix rounds as the round, round N of review.fixRounds", async () => {
		const world = makeWorld();
		changesFor(world, 1);
		world.reviewRoundAgent = (req) => {
			world.checkOk = false;
			return {
				kind: 'fixed',
				summary: 'Escaped.',
				declined: [],
				sessionId: req.sessionId,
				costUsd: 1
			};
		};
		world.fixAgent = (req) => {
			world.checkOk = true;
			return { kind: 'fixed', summary: 'Linted.', sessionId: req.resume, costUsd: 1 };
		};

		await buildFeature(deps(world), setup(world, roundOf({ fixRounds: 4 })), '1');
		expect(askedOf(world, 'fix')).toHaveLength(1);
		const shown = world.doing.filter((d) => d.kind === 'building' && d.step === 'reviewRound');
		expect(shown.length).toBeGreaterThan(1);
		for (const d of shown) expect(d).toMatchObject({ round: 1, rounds: 4 });
	});

	describe("the pull request's Review section", () => {
		it('lists each Review and Review round in order, with the round and its fix rounds costing what they cost, then the issues still open', async () => {
			const world = makeWorld();
			changesFor(world, 1);
			world.reviewRoundAgent = (req) => {
				world.checkOk = false;
				return {
					kind: 'fixed',
					summary: 'Fixed what the Review found.',
					declined: [],
					sessionId: req.sessionId,
					costUsd: 2
				};
			};
			world.fixAgent = (req) => {
				world.checkOk = true;
				return { kind: 'fixed', summary: 'Fixed the lint.', sessionId: req.resume, costUsd: 1 };
			};

			await buildFeature(deps(world), setup(world), '1');
			expect(body(world)).toContain(
				[
					'## Review',
					'',
					'### Review 1: Changes asked',
					'',
					'One bug.',
					'',
					'### Review round 1: fixed, $3.00',
					'',
					'Fixed what the Review found.\n\nFixed the lint.',
					'',
					'### Review 2: Approve',
					'',
					'Reads well.',
					'',
					'### Still open',
					'',
					'- `src/marks.ts:3`: It escapes twice.'
				].join('\n')
			);
		});

		it('lists no issues as open when the last Review raised none', async () => {
			const world = makeWorld();
			world.reviewAgent = (req) => reviewed(req, 'approve', []);

			await buildFeature(deps(world), setup(world), '1');
			expect(body(world)).toContain('## Review\n\n### Review 1: Approve\n\nReads well.');
			expect(body(world)).not.toContain('Still open');
		});

		it('lists the Review that asked for changes, and what it left open, when no round was allowed', async () => {
			const world = makeWorld();
			changesFor(world, 9);

			await buildFeature(deps(world), setup(world, roundOf({ fixRounds: 0 })), '1');
			expect(body(world)).toContain(
				'## Review\n\n### Review 1: Changes asked\n\nOne bug.\n\n### Still open\n\n- `src/marks.ts:3`: It escapes twice.'
			);
			expect(body(world)).not.toContain('Review round');
		});

		it('lists a round that was thrown away with why, and what the last Review left open', async () => {
			const world = makeWorld();
			changesFor(world, 9);
			world.reviewRoundAgent = (req) => ({
				kind: 'blocked',
				blocker: 'The Review is wrong.',
				sessionId: req.sessionId,
				costUsd: 1
			});

			await buildFeature(deps(world), setup(world), '1');
			expect(body(world)).toContain(
				[
					'### Review 1: Changes asked',
					'',
					'One bug.',
					'',
					'### Review round 1: thrown away, $1.00',
					'',
					'it reports itself blocked: The Review is wrong.',
					'',
					'### Still open',
					'',
					'- `src/marks.ts:3`: It escapes twice.'
				].join('\n')
			);
		});

		it('lists every round of the build, the last Review still asking for changes', async () => {
			const world = makeWorld();
			changesFor(world, 9);

			await buildFeature(deps(world), setup(world), '1');
			const headings = body(world)
				.split('\n')
				.filter((l) => l.startsWith('### '));
			expect(headings).toEqual([
				'### Review 1: Changes asked',
				'### Review round 1: fixed, $2.00',
				'### Review 2: Changes asked',
				'### Review round 2: fixed, $2.00',
				'### Review 3: Changes asked',
				'### Still open'
			]);
		});

		it('says a Review that did not finish did not', async () => {
			const world = makeWorld();
			changesFor(world, 1);
			let reviews = 0;
			world.settle = (req) =>
				req.kind === 'review' && (reviews += 1) === 2
					? {
							kind: 'failed',
							why: 'it reached its budget',
							failure: 'budget',
							sessionId: req.sessionId,
							costUsd: 3
						}
					: undefined;

			await buildFeature(deps(world), setup(world), '1');
			expect(body(world)).toContain('### Review round 1: fixed, $2.00');
			expect(body(world)).toContain('### Review 2: did not finish');
			expect(body(world)).not.toContain('Still open');
		});

		it('counts the rounds as their own kind of work in the cost lines', async () => {
			const world = makeWorld();
			changesFor(world, 9);

			await buildFeature(deps(world), setup(world), '1');
			// the Reviews are $0.50 each, the rounds $2 each
			expect(body(world)).toContain('- Review: $1.50\n- Review rounds: $4.00');
		});

		it('leaves the cost line out when no round ran', async () => {
			const world = makeWorld();

			await buildFeature(deps(world), setup(world), '1');
			expect(body(world)).not.toContain('Review rounds:');
		});
	});

	it('comments only the last Review on the pull request', async () => {
		const world = makeWorld();
		changesFor(world, 1);

		await buildFeature(deps(world), setup(world), '1');
		const comments = world.host.pulls[0]?.comments ?? [];
		expect(comments).toHaveLength(1);
		expect(comments[0]).toContain('**Nightjar review: approve**');
		expect(comments[0]).not.toContain('One bug.');
	});

	it('runs on a rebuild whose Feedback round ran first', async () => {
		const world = makeWorld();
		const d = deps(world);
		await buildFeature(d, setup(world), '1');
		const pull = world.host.pulls[0];
		if (pull === undefined) throw new Error('no draft was opened');
		world.host.give(pull, { kind: 'review', author: 'ann', trusted: true, body: 'Rename it.' });
		changesFor(world, 1);
		world.asked.length = 0;

		await buildFeature(d, setup(world), '1');
		expect(kinds(world)).toEqual(['feedback', 'review', 'reviewRound', 'review']);
	});

	describe('declining an issue', () => {
		const OTHER = { file: 'README.md', problem: 'The flag is not described.' };
		const decline = (req: ReviewRoundRequest, ...which: number[]): ReviewRoundOutcome => ({
			kind: 'fixed',
			summary: 'Answered the Review.',
			declined: which.flatMap((n) => {
				const issue = req.issues[n];
				return issue === undefined ? [] : [{ ...issue, reason: `Reason ${String(n)}.` }];
			}),
			sessionId: req.sessionId,
			costUsd: 2
		});

		it('gives the next Review every issue declined, with its reason', async () => {
			const world = makeWorld();
			let reviews = 0;
			world.reviewAgent = (req) =>
				reviewed(req, (reviews += 1) <= 1 ? 'changes' : 'approve', [ISSUE, OTHER]);
			world.reviewRoundAgent = (req) => decline(req, 1);

			await buildFeature(deps(world), setup(world), '1');
			const [first, second] = askedOf(world, 'review');
			expect(first?.declined).toEqual([]);
			expect(second?.declined).toEqual([{ ...OTHER, reason: 'Reason 1.' }]);
		});

		it('keeps what an earlier round declined for every Review after it', async () => {
			const world = makeWorld();
			changesFor(world, 9);
			world.reviewRoundAgent = (req) => decline(req, 0);

			await buildFeature(deps(world), setup(world), '1');
			const reviews = askedOf(world, 'review');
			expect(reviews.map((r) => r.declined.length)).toEqual([0, 1, 2]);
			expect(reviews[2]?.declined.map((d) => d.reason)).toEqual(['Reason 0.', 'Reason 0.']);
		});

		it('gives each later Review round every issue declined before it, with its reason', async () => {
			const world = makeWorld();
			changesFor(world, 9);
			world.reviewRoundAgent = (req) => decline(req, 0);

			await buildFeature(deps(world), setup(world), '1');
			const [first, second] = askedOf(world, 'reviewRound');
			expect(first?.declined).toEqual([]);
			expect(second?.declined).toEqual([{ ...ISSUE, reason: 'Reason 0.' }]);
		});

		it('counts per build: a new Go starts with none', async () => {
			const world = makeWorld();
			changesFor(world, 1);
			world.reviewRoundAgent = (req) => decline(req, 0);
			const d = deps(world);
			const s = setup(world);
			await buildFeature(d, s, '1');
			expect(askedOf(world, 'review')[1]?.declined).toHaveLength(1);
			world.asked.length = 0;
			changesFor(world, 1);

			await buildFeature(d, s, '1');
			expect(askedOf(world, 'review')[0]?.declined).toEqual([]);
		});

		it('is no failed round when it declines every issue and changes no file: the Review runs again', async () => {
			const world = makeWorld();
			changesFor(world, 1);
			world.reviewRoundWrites = false;
			world.reviewRoundAgent = (req) => decline(req, 0);

			await buildFeature(deps(world), setup(world), '1');
			expect(kinds(world)).toEqual(['build', 'build', 'review', 'reviewRound', 'review']);
			expect(subjects(world)).toEqual(['Use it in marks (#3)', 'Share the function (#2)']);
			expect(world.trees.sides.size).toBe(0);
			expect(ledger(world).filter((e) => e.step === 'reviewRound')).toHaveLength(1);
			expect(world.tracker.signalsOf('1')).not.toContain('needsInfo');
		});

		it('is a failed round when it declines only some issues and changes no file', async () => {
			const world = makeWorld();
			let reviews = 0;
			world.reviewAgent = (req) =>
				reviewed(req, (reviews += 1) <= 9 ? 'changes' : 'approve', [ISSUE, OTHER]);
			world.reviewRoundWrites = false;
			world.reviewRoundAgent = (req) => decline(req, 0);

			await buildFeature(deps(world), setup(world), '1');
			expect(kinds(world)).toEqual(['build', 'build', 'review', 'reviewRound']);
			expect(world.trees.sides.has('factory/1-one-escape-attempt-review')).toBe(false);
			expect(body(world)).not.toContain('Reason 0.');
		});

		it('commits what a round fixed beside the issues it declined', async () => {
			const world = makeWorld();
			let reviews = 0;
			world.reviewAgent = (req) =>
				reviewed(req, (reviews += 1) <= 1 ? 'changes' : 'approve', [ISSUE, OTHER]);
			world.reviewRoundAgent = (req) => decline(req, 1);

			await buildFeature(deps(world), setup(world), '1');
			expect(subjects(world)[0]).toBe('Answer the Review, round 1');
		});

		it('lists the issues declined at the end of the build on the pull request, with their reasons', async () => {
			const world = makeWorld();
			let reviews = 0;
			world.reviewAgent = (req) =>
				reviewed(req, (reviews += 1) <= 1 ? 'changes' : 'approve', [ISSUE, OTHER]);
			world.reviewRoundAgent = (req) => decline(req, 0, 1);
			world.reviewRoundWrites = false;

			await buildFeature(deps(world), setup(world), '1');
			expect(body(world)).toContain(
				'### Issues declined\n\n- `src/marks.ts:3`: It escapes twice.\n  Reason: Reason 0.\n- `README.md`: The flag is not described.\n  Reason: Reason 1.'
			);
			// the Review section ends with them, after the issues still open
			expect(body(world).indexOf('### Issues declined')).toBeGreaterThan(
				body(world).indexOf('### Still open')
			);
			expect(body(world).indexOf('### Issues declined')).toBeGreaterThan(
				body(world).indexOf('## Review')
			);
		});

		it('lists none on a pull request where nothing was declined', async () => {
			const world = makeWorld();
			changesFor(world, 1);

			await buildFeature(deps(world), setup(world), '1');
			expect(body(world)).not.toContain('Issues declined');
		});
	});

	it('runs on a note Feature, keeping the round to the note', async () => {
		const world = makeWorld();
		world.tracker.add({
			id: '9',
			title: 'Why the build is slow',
			body: '**Workflow:** exploration\n\nWhy?\n\n### Acceptance criteria\n\n- [ ] a note says why',
			assignees: ['ann'],
			signals: ['go']
		});
		changesFor(world, 1);
		const note: WorkflowConfig = { prompt: 'Find out.', output: 'note', steps: [] };

		await buildFeature(deps(world), setup(world, { workflows: { exploration: note } }), '9');
		const [round] = askedOf(world, 'reviewRound');
		expect(round?.output).toBe('note');
		expect(askedOf(world, 'review')).toHaveLength(2);
	});

	describe('hands the Feature to a person', () => {
		const said = (world: World) =>
			world.tracker.said('1').filter((c) => c.includes('still needs a person'));

		it('when a round fails: needs a person, a comment naming what the Review left open and ending with its Next step, and agent-working off', async () => {
			const world = makeWorld();
			changesFor(world, 9);
			world.reviewRoundAgent = (req) => ({
				kind: 'blocked',
				blocker: 'The Review is wrong.',
				sessionId: req.sessionId,
				costUsd: 1
			});

			await buildFeature(deps(world), setup(world), '1');
			expect(world.tracker.signalsOf('1')).toContain('human');
			expect(world.tracker.signalsOf('1')).not.toContain('working');
			expect(world.tracker.signalsOf('1')).not.toContain('needsInfo');
			const [comment, ...more] = said(world);
			expect(more).toEqual([]);
			expect(comment).toContain(world.host.pulls[0]?.url);
			expect(comment).toContain('Review round 1 was thrown away: it reports itself blocked');
			expect(comment).toContain('factory/1-one-escape-attempt-review');
			expect(comment).toContain('The last Review said changes');
			expect(comment).toContain('- `src/marks.ts:3`: It escapes twice.');
			expect(comment?.indexOf('**Next step**')).toBeGreaterThan(
				comment?.indexOf('It escapes twice') ?? 0
			);
			expect(comment).toMatch(
				/\*\*Next step\*\*[\s\S]*remove `ready-for-human` and add `factory-go`/
			);
			expect(world.happened).toContainEqual(
				expect.objectContaining({ kind: 'needs-info', feature: '1' })
			);
		});

		it('when the rounds run out and the last Review still says changes', async () => {
			const world = makeWorld();
			changesFor(world, 9);

			await buildFeature(deps(world), setup(world), '1');
			expect(askedOf(world, 'reviewRound')).toHaveLength(2);
			expect(world.tracker.signalsOf('1')).toContain('human');
			expect(world.tracker.signalsOf('1')).not.toContain('working');
			const [comment, ...more] = said(world);
			expect(more).toEqual([]);
			expect(comment).toContain('2 Review rounds');
			expect(comment).toContain('still says changes');
			expect(comment).toContain('- `src/marks.ts:3`: It escapes twice.');
			expect(comment).toContain('**Next step**');
			expect(world.host.pulls).toHaveLength(1);
		});

		it('not when the last Review approves after a round', async () => {
			const world = makeWorld();
			changesFor(world, 1);

			await buildFeature(deps(world), setup(world), '1');
			expect(world.tracker.signalsOf('1')).not.toContain('human');
			expect(said(world)).toEqual([]);
		});

		it('not with review.fixRounds 0: the Review stays advisory', async () => {
			const world = makeWorld();
			changesFor(world, 9);

			await buildFeature(deps(world), setup(world, roundOf({ fixRounds: 0 })), '1');
			expect(world.tracker.signalsOf('1')).not.toContain('human');
		});

		it('not when the run paused: it gives the Go back', async () => {
			const world = makeWorld();
			changesFor(world, 9);
			world.settle = (req) =>
				req.kind === 'reviewRound'
					? {
							kind: 'paused',
							why: "the plan's usage limit was reached",
							sessionId: 's',
							costUsd: 0
						}
					: undefined;

			await buildFeature(deps(world), setup(world), '1');
			expect(world.tracker.signalsOf('1')).not.toContain('human');
			expect(world.tracker.signalsOf('1')).toContain('go');
		});
	});

	describe('throws a round that fails away, keeping the commits before it', () => {
		const side = 'factory/1-one-escape-attempt-review';
		const cases: { name: string; script: (world: World) => void; why: string; kept: boolean }[] = [
			{
				name: 'the check stays red after its fix rounds',
				script: (world) => {
					world.reviewRoundAgent = (req) => {
						world.checkOk = false;
						return {
							kind: 'fixed',
							summary: 'Tried.',
							declined: [],
							sessionId: req.sessionId,
							costUsd: 2
						};
					};
				},
				why: 'still fails after the fix rounds',
				kept: true
			},
			{
				name: 'the Session fails',
				script: (world) => {
					world.settle = (req) =>
						req.kind === 'reviewRound'
							? {
									kind: 'failed',
									why: 'it crashed',
									failure: 'lasting',
									sessionId: 's',
									costUsd: 1
								}
							: undefined;
				},
				why: 'it crashed',
				// the Session was settled before it wrote anything
				kept: false
			},
			{
				name: 'it reports itself blocked',
				script: (world) => {
					world.reviewRoundAgent = (req) => ({
						kind: 'blocked',
						blocker: 'Wrong.',
						sessionId: req.sessionId,
						costUsd: 1
					});
				},
				why: 'it reports itself blocked: Wrong.',
				kept: true
			}
		];

		it.each(cases)('onto -attempt-review when $name', async ({ script, why, kept }) => {
			const world = makeWorld();
			changesFor(world, 9);
			script(world);

			await buildFeature(deps(world), setup(world), '1');
			expect(world.trees.sides.has(side)).toBe(kept);
			expect(subjects(world)).toEqual(['Use it in marks (#3)', 'Share the function (#2)']);
			expect(askedOf(world, 'reviewRound')).toHaveLength(1);
			expect(world.host.pulls).toHaveLength(1);
			expect(world.tracker.said('1').join('\n')).toContain(why);
		});

		it('when it says it fixed the issues but changed no file, with nothing to keep', async () => {
			const world = makeWorld();
			changesFor(world, 9);
			world.reviewRoundWrites = false;

			await buildFeature(deps(world), setup(world), '1');
			expect(world.trees.sides.has(side)).toBe(false);
			expect(subjects(world)).toEqual(['Use it in marks (#3)', 'Share the function (#2)']);
			expect(askedOf(world, 'reviewRound')).toHaveLength(1);
			expect(world.tracker.signalsOf('1')).toContain('human');
			const comment = world.tracker.said('1').join('\n');
			expect(comment).toContain('changed no file');
			expect(comment).not.toContain('attempt-review');
		});

		it('on real git too', async () => {
			const world = makeGitWorld();
			changesFor(world, 9);
			world.reviewRoundAgent = (req) => ({
				kind: 'blocked',
				blocker: 'Wrong.',
				sessionId: req.sessionId,
				costUsd: 1
			});

			await buildFeature(deps(world), setup(world), '1');
			expect(subjects(world)).toEqual(['Use it in marks (#3)', 'Share the function (#2)']);
			expect(git(world, tree(), 'branch', '--list', side).trim()).toContain(side);
			expect(git(world, tree(), 'show', '--stat', '--format=', side)).toContain('review-');
		});
	});
});

describe('a request for changes under --watch', () => {
	// a day's limit no spec here reaches
	const roomy = (world: World) => setup(world, { limits: { ...LIMITS, dailyUsd: 1000 } });

	// Feature 1 built into a draft pull request, which leaves it with no Signal; every run after shares the seams, so Session ids never repeat
	async function opened(world: World) {
		const d = deps(world);
		const s = roomy(world);
		await buildFeature(d, s, '1');
		const pull = world.host.pulls[0];
		if (pull === undefined) throw new Error('no draft was opened');
		world.asked.length = 0;
		// a run of the queue: --watch stops on its first idle tick, --once after one piece of work
		const run = async (once = false) => {
			const stop = new AbortController();
			const pass = feedbackPass(world.host, (f, asked) => buildFeature(d, s, f.id, { asked }));
			const q: QueueDeps = {
				tracker: world.tracker,
				person: 'ann',
				build: ({ id }) => buildFeature(d, s, id),
				status: d.status,
				now: d.now,
				say: () => undefined,
				sleep: () => {
					stop.abort();
					return Promise.resolve();
				},
				signal: stop.signal,
				signals: DEFAULT_SIGNAL_NAMES,
				...(pass === null ? {} : { feedback: pass })
			};
			return queue(q, once);
		};
		return { pull, run };
	}

	const rounds = (world: World) => askedOf(world, 'feedback');
	const newest = (world: World) => world.trees.messages(tree())[0] ?? '';
	const ask = (world: World, pull: Pull, author = 'ann', trusted = true) =>
		world.host.requestChanges(pull, { author, trusted, body: `Rename it, says ${author}.` });

	it('starts a Feedback round on a trusted request for changes with no Go given, and its commit names the request', async () => {
		const world = makeWorld();
		const { pull, run } = await opened(world);
		const id = ask(world, pull);
		expect(world.tracker.signalsOf('1')).toEqual([]);

		expect(await run()).toBe(130);
		expect(rounds(world).map((r) => r.feedback.map((f) => f.id))).toEqual([[id]]);
		expect(newest(world)).toContain(`Factory-Feedback: ${id}\nFactory-Feedback-Asked: ${id}\n`);
		expect(world.host.pushes).toHaveLength(2);
		expect(world.host.pulls[0]?.comments.some((c) => c.includes('Answered in'))).toBe(true);
		expect(world.tracker.signalsOf('1')).toEqual([]);
	});

	it('starts no second round on the same request, as its commit is later than it', async () => {
		const world = makeWorld();
		const { pull, run } = await opened(world);
		ask(world, pull);
		await run();
		await run();
		expect(rounds(world)).toHaveLength(1);

		const again = ask(world, pull);
		await run();
		const [, second] = rounds(world);
		expect(rounds(world)).toHaveLength(2);
		expect(second?.feedback.map((f) => f.id)).toEqual([again]);
	});

	it('starts nothing on a request for changes from a reviewer it does not trust', async () => {
		const world = makeWorld();
		const { pull, run } = await opened(world);
		ask(world, pull, 'mallory', false);

		expect(await run(true)).toBe(0);
		expect(world.asked).toEqual([]);
		expect(world.host.pushes).toHaveLength(1);
	});

	it('starts nothing on a Feature that carries needs info or working', async () => {
		for (const signal of ['needsInfo', 'working'] as const) {
			const world = makeWorld();
			const { pull, run } = await opened(world);
			ask(world, pull);
			await world.tracker.addSignal('1', signal);

			await run();
			expect(world.asked).toEqual([]);
		}
	});

	it('starts nothing on a Feature assigned to someone else', async () => {
		const world = makeWorld();
		const { pull, run } = await opened(world);
		ask(world, pull);
		world.tracker.add({ id: '1', title: 'One escape', assignees: ['bob'], children: ['3', '2'] });

		await run();
		expect(world.asked).toEqual([]);
	});

	it('builds a Feature with the Go before one waiting on feedback', async () => {
		const world = makeWorld();
		const { pull, run } = await opened(world);
		ask(world, pull);
		world.tracker.add({
			id: '10',
			title: 'Next',
			assignees: ['ann'],
			signals: ['go'],
			children: ['11']
		});
		world.tracker.add({ id: '11', title: 'Ticket 11', signals: ['ready'] });

		await run();
		expect(world.asked.map((r) => r.kind)).toEqual(['build', 'review', 'feedback', 'review']);
		expect(world.asked[0]).toMatchObject({ ticket: { id: '11' } });
	});

	it('starts no sixth automatic round: the Feature gets needs a person and one comment saying why, and a new Go starts the next', async () => {
		const world = makeWorld();
		const { pull, run } = await opened(world);
		for (let n = 1; n <= 5; n += 1) {
			ask(world, pull);
			expect(await run(true)).toBe(0);
		}
		expect(rounds(world)).toHaveLength(5);

		const sixth = ask(world, pull);
		expect(await run(true)).toBe(0);
		expect(rounds(world)).toHaveLength(5);
		expect(world.tracker.signalsOf('1')).toContain('human');
		const limit = '5 automatic Feedback rounds';
		const said = () => world.tracker.said('1').filter((c) => c.includes(limit));
		expect(said()).toHaveLength(1);
		const [why] = said();
		expect(why).toContain(`Nightjar did not answer the changes ann asked for on ${pull.url}`);
		expect(why).toContain('**Next step**');

		await run();
		expect(said()).toHaveLength(1);
		expect(rounds(world)).toHaveLength(5);

		await world.tracker.removeSignal('1', 'human');
		await world.tracker.addSignal('1', 'go');
		await run(true);
		expect(rounds(world)).toHaveLength(6);
		const last = rounds(world).at(-1);
		expect(last?.feedback.map((f) => f.id)).toEqual([sixth]);
		expect(newest(world)).not.toContain('Factory-Feedback-Asked');
	});

	it('counts only the rounds a request for changes started, not those a Go started', async () => {
		const world = makeWorld();
		const { pull, run } = await opened(world);
		for (let n = 1; n <= 5; n += 1) {
			const body = `Note ${String(n)}.`;
			world.host.give(pull, { kind: 'comment', author: 'ann', trusted: true, body });
			await world.tracker.addSignal('1', 'go');
			await run(true);
		}
		ask(world, pull);
		await run(true);
		expect(rounds(world)).toHaveLength(6);
		expect(world.tracker.signalsOf('1')).not.toContain('human');
	});

	it('lists in the dry run the Features it would build, then those it would answer feedback on', async () => {
		const world = makeWorld();
		const { pull } = await opened(world);
		ask(world, pull);
		world.tracker.add({
			id: '10',
			title: 'Next',
			assignees: ['ann'],
			signals: ['go'],
			children: ['11']
		});
		world.tracker.add({ id: '11', title: 'Ticket 11', signals: ['ready'] });
		const lines: string[] = [];
		const say = (line: string) => lines.push(line);

		await dryRun({ tracker: world.tracker, codeHost: world.host, person: 'ann', say });
		expect(lines).toEqual([
			'would build #10 Next',
			`would answer feedback on #1 One escape, on ${pull.url}`
		]);
		expect(world.asked).toEqual([]);
		expect(world.host.pushes).toHaveLength(1);
	});

	it('leaves out of the dry run a request it does not trust, and says nothing of feedback over a Code host without openPulls', async () => {
		const world = makeWorld();
		const { pull } = await opened(world);
		ask(world, pull, 'mallory', false);
		const lines: string[] = [];
		const say = (line: string) => lines.push(line);
		await dryRun({ tracker: world.tracker, codeHost: world.host, person: 'ann', say });
		expect(lines).toEqual(['no Feature with the Go is assigned to ann']);

		ask(world, pull);
		const { openPulls: _gone, ...without } = world.host;
		lines.length = 0;
		await dryRun({ tracker: world.tracker, codeHost: without, person: 'ann', say });
		expect(lines).toEqual(['no Feature with the Go is assigned to ann']);
	});

	it('has no pass over a Code host without openPulls, or without feedback and reply', () => {
		const world = makeWorld();
		const answer = () => Promise.reject(new Error('never'));
		expect(feedbackPass(world.host, answer)).not.toBeNull();
		const { openPulls: _a, ...noList } = world.host;
		expect(feedbackPass(noList, answer)).toBeNull();
		const { feedback: _b, reply: _c, ...noFeedback } = world.host;
		expect(feedbackPass(noFeedback, answer)).toBeNull();
	});
});

describe('the Logbook the build loop writes', () => {
	// each entry in one line: its kind, a Signal as +name or -name, then its Ticket and Session where it has them
	const book = (world: World) =>
		world.logbook.all().map((e) => {
			const head = e.kind === 'signal' ? `${e.on ? '+' : '-'}${e.signal}` : e.kind;
			return [head, e.ticket && `#${e.ticket}`, e.session].filter(Boolean).join(' ');
		});
	const entries = <K extends LogbookEntry['kind']>(world: World, kind: K) => {
		const of = (e: LogbookEntry): e is Extract<LogbookEntry, { kind: K }> => e.kind === kind;
		return world.logbook.all().filter(of);
	};
	const at9 = new Date(2026, 9, 30, 9).toISOString();
	const branch = 'factory/1-one-escape';

	it('writes a build from the Go to its draft pull request, every entry under the Feature', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		expect(book(world)).toEqual([
			'buildStarted',
			'+working',
			'-go',
			'ticketStarted #2',
			'+working #2',
			'ticketBuilt #2 session-1',
			'-working #2',
			'ticketStarted #3',
			'+working #3',
			'ticketBuilt #3 session-2',
			'-working #3',
			'-working',
			'review session-3',
			'pullOpened'
		]);
		const all = world.logbook.all();
		expect(new Set(all.map((e) => e.feature))).toEqual(new Set(['1']));
		expect(new Set(all.map((e) => e.at))).toEqual(new Set([at9]));
		expect(entries(world, 'buildStarted')).toMatchObject([{ by: 'go', branch, workflow: null }]);
		expect(entries(world, 'ticketBuilt').map((e) => e.commit)).toEqual(['1', '2']);
		expect(entries(world, 'review')).toMatchObject([
			{
				verdict: 'approve',
				summary: 'Reads well.',
				issues: [{ file: 'a.ts', line: 2, problem: 'nit' }]
			}
		]);
		expect(entries(world, 'pullOpened')).toMatchObject([
			{ url: 'https://code.example/pull/100', created: true }
		]);
	});

	it('names the request for changes that started a build with no Go', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1', { asked: 'review-7' });
		expect(entries(world, 'buildStarted')).toMatchObject([
			{ by: 'feedback', asked: 'review-7', branch }
		]);
	});

	it('says a later build gave the open pull request a new body, not a new draft', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world), '1');
		await world.tracker.addSignal('1', 'go');
		await buildFeature(deps(world), setup(world), '1');
		expect(entries(world, 'pullOpened').map((e) => e.created)).toEqual([true, false]);
	});

	it('writes the setup that ran, and the hand-over when it fails', async () => {
		const ok = makeWorld();
		await buildFeature(deps(ok), setup(ok, { setupCommand: 'make deps' }), '1');
		expect(entries(ok, 'setup')).toMatchObject([{ command: 'make deps', ok: true }]);

		const failed = makeWorld();
		failed.setupOk = false;
		await buildFeature(deps(failed), setup(failed, { setupCommand: 'make deps' }), '1');
		expect(book(failed)).toEqual([
			'buildStarted',
			'+working',
			'-go',
			'setup',
			'handed',
			'-working',
			'+needsInfo'
		]);
		expect(entries(failed, 'handed')).toMatchObject([
			{ to: 'needsInfo', why: 'the setup command `make deps` failed' }
		]);
	});

	it('writes each red check with the gate report its fix round was handed, then the hand-over', async () => {
		const world = makeWorld();
		world.checkOk = false;
		await buildFeature(deps(world), setup(world), '1');
		expect(entries(world, 'checkRed')).toEqual(
			[1, 2, 3].map((round) => ({
				at: at9,
				feature: '1',
				kind: 'checkRed',
				report: `lint: 1 problem (run ${String(round)})`,
				round,
				rounds: 3,
				ticket: '2',
				session: 'session-1'
			}))
		);
		expect(entries(world, 'handed')).toMatchObject([
			{ to: 'needsInfo', why: 'the check fails after #2' }
		]);
		expect(book(world).slice(-2)).toEqual(['handed', '+needsInfo']);
	});

	it('writes a Ticket handed back, and the attempt branch its work was thrown away onto', async () => {
		const world = makeWorld();
		world.acts['2'] = 'fail';
		await buildFeature(deps(world), setup(world), '1');
		expect(book(world).slice(3, 9)).toEqual([
			'ticketStarted #2',
			'+working #2',
			'handed #2',
			'thrownAway #2',
			'-ready #2',
			'+needsInfo #2'
		]);
		expect(entries(world, 'thrownAway')).toMatchObject([
			{ branch: attemptBranch(branch, '2'), why: 'it reached its budget', ticket: '2' }
		]);
		expect(entries(world, 'handed')).toMatchObject([
			{ to: 'needsInfo', why: 'it reached its budget', ticket: '2' },
			{ to: 'needsInfo', why: 'it built nothing' }
		]);
	});

	it('hands a Ticket to a person once its question rounds are used up', async () => {
		const world = makeWorld();
		world.acts['2'] = 'ask';
		world.tracker.say('2', { author: 'ann', body: `${QUESTIONS_MARK}\nround 1`, trusted: true });
		world.tracker.say('2', { author: 'ann', body: `${QUESTIONS_MARK}\nround 2`, trusted: true });
		await buildFeature(deps(world), setup(world), '1');
		expect(entries(world, 'handed')[0]).toMatchObject({ to: 'human', ticket: '2' });
		expect(book(world)).toContain('+human #2');
	});

	it('writes the pause and the work it threw away when a fix round pauses', async () => {
		const world = makeWorld();
		world.checkOk = false;
		const why = "today's estimated spend reached the daily limit";
		const pause: Ending = { kind: 'paused', why, sessionId: 'session-x', costUsd: 0 };
		world.settle = (req) => (req.kind === 'fix' ? pause : undefined);
		await buildFeature(deps(world), setup(world), '1');
		expect(book(world).slice(-6)).toEqual([
			'checkRed #2 session-1',
			'thrownAway #2',
			'-working #2',
			'-working',
			'paused',
			'+go'
		]);
		expect(entries(world, 'thrownAway')).toMatchObject([
			{ branch: attemptBranch(branch, '2'), why: `paused: ${why}` }
		]);
		expect(entries(world, 'paused')).toMatchObject([{ why }]);
	});

	it('writes the pause of a day already over before any Ticket', async () => {
		const world = makeWorld();
		await buildFeature(deps(world), setup(world, { limits: { ...LIMITS, dailyUsd: 0 } }), '1');
		expect(book(world)).toEqual(['buildStarted', '+working', '-go', '-working', 'paused', '+go']);
	});

	it('writes the work thrown away when a person stops it', async () => {
		const world = makeWorld();
		world.settle = (req) => {
			if (req.kind !== 'build') return undefined;
			write(world, req.at.folder, 'half-done.txt');
			return { kind: 'aborted', sessionId: req.sessionId, costUsd: 1 };
		};
		await buildFeature(deps(world), setup(world), '1');
		expect(entries(world, 'thrownAway')).toMatchObject([
			{ branch: attemptBranch(branch, '2'), why: 'stopped by a person', ticket: '2' }
		]);
	});

	it('writes a Review that did not finish as having no verdict', async () => {
		const world = makeWorld();
		world.settle = (req) =>
			req.kind === 'review'
				? {
						kind: 'failed',
						why: 'it reached its budget',
						failure: 'budget',
						sessionId: req.sessionId,
						costUsd: 3
					}
				: undefined;
		await buildFeature(deps(world), setup(world), '1');
		expect(entries(world, 'review')).toMatchObject([
			{ verdict: null, summary: null, issues: [], session: 'session-3' }
		]);
	});

	it("writes the Workflow, and each Step's verdict with its Session", async () => {
		const world = makeWorld();
		const feature = world.tracker.items.get('1');
		if (feature) world.tracker.items.set('1', { ...feature, body: '**Workflow:** w' });
		const flow: WorkflowConfig = {
			steps: [
				{ name: 'tidy', prompt: '/tidy', point: 'afterEachTicket' },
				{ name: 'critique', prompt: '/critique', point: 'afterAllTickets' }
			]
		};
		world.stepAgent = (req) =>
			req.step.name === 'critique'
				? { kind: 'blocked', blocker: 'no browser', sessionId: req.sessionId, costUsd: 1 }
				: stepDone(req);
		await buildFeature(deps(world), setup(world, { workflows: { w: flow } }), '1');
		expect(entries(world, 'buildStarted')).toMatchObject([{ workflow: 'w' }]);
		const verdicts = entries(world, 'stepVerdict');
		expect(verdicts).toMatchObject([
			{ step: 'tidy', ticket: '2', session: 'session-2', verdict: 'done', rounds: 1, left: [] },
			{ step: 'tidy', ticket: '3', session: 'session-4', verdict: 'done', rounds: 1, left: [] },
			{
				step: 'critique',
				session: 'session-5',
				verdict: 'undone',
				why: 'it reported itself blocked: no browser'
			}
		]);
		expect(verdicts[2]?.ticket).toBeUndefined();
		expect(verdicts.every((e) => e.workflow === 'w')).toBe(true);
	});

	it('hands a note to a person to read', async () => {
		const world = makeWorld();
		const feature = world.tracker.items.get('1');
		if (feature) world.tracker.items.set('1', { ...feature, body: '**Workflow:** exploration' });
		const note: WorkflowConfig = { prompt: 'Find out.', output: 'note', steps: [] };
		await buildFeature(deps(world), setup(world, { workflows: { exploration: note } }), '1');
		expect(book(world).slice(-3)).toEqual(['pullOpened', 'handed', '+human']);
		expect(entries(world, 'handed')).toMatchObject([
			{ to: 'human', why: 'its note is for a person to read' }
		]);
	});
});

describe('pullFixLimits', () => {
	it('takes each Pull-check limit factory.json sets, and the default for one it leaves out', () => {
		expect(pullFixLimits(undefined)).toEqual({
			pullFixRounds: 2,
			pullFixUsd: 5,
			pullFixMinutes: 30
		});
		expect(pullFixLimits({ fixRounds: 4, fixMinutes: 10 })).toEqual({
			pullFixRounds: 4,
			pullFixUsd: 5,
			pullFixMinutes: 10
		});
	});
});

describe('a Feature with a **Base:** line, as a botPulls Source makes one', () => {
	const BOT_BRANCH = 'dependabot/npm_and_yarn/left-pad-1.1.0';

	// the Feature of the world, its body naming the bot's branch and pull request
	const fromBot = async (world: World, body: string) => {
		world.tracker.add({
			id: '1',
			title: 'One escape',
			assignees: ['ann'],
			signals: ['go'],
			children: ['3', '2'],
			body
		});
		const bot = await world.host.createDraft({
			title: 'Bump left-pad from 1.0.0 to 1.1.0',
			head: BOT_BRANCH,
			base: 'main',
			body: 'Release notes.'
		});
		world.host.markReady(bot);
		return bot;
	};

	const opening = (world: World) => {
		const bases: string[] = [];
		const inner = deps(world);
		const open: OpenWorktree = (root, worktrees, branch, baseBranch, env) => {
			bases.push(`${branch} from ${baseBranch}`);
			return inner.openWorktree(root, worktrees, branch, baseBranch, env);
		};
		return { bases, deps: { ...inner, openWorktree: open } };
	};

	it("cuts the Feature's branch from that ref, and opens its own draft against the base branch", async () => {
		const world = makeWorld();
		const bot = await fromBot(world, `A red bot pull request.\n\n${baseLine(BOT_BRANCH)}\n`);
		const { bases, deps: withBases } = opening(world);
		await buildFeature(withBases, setup(world), '1');
		expect(bases).toEqual([`factory/1-one-escape from ${BOT_BRANCH}`]);
		const mine = world.host.pulls.filter((p) => p.id !== bot.id);
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({ base: 'main', head: 'factory/1-one-escape' });
		// the bot's branch is never pushed to
		expect(world.host.pushes.map((p) => p.branch)).not.toContain(BOT_BRANCH);
	});

	it("comments on the bot's pull request with a link to its own, once, and closes nothing", async () => {
		const world = makeWorld();
		const body = `A red bot pull request.\n\n${baseLine(BOT_BRANCH)}\n`;
		const bot = await fromBot(world, `${body}<!-- placeholder -->`);
		world.tracker.add({
			id: '1',
			title: 'One escape',
			assignees: ['ann'],
			signals: ['go'],
			children: ['3', '2'],
			body: `${body}${botPullMarker(bot)}\n`
		});
		await buildFeature(deps(world), setup(world), '1');
		const mine = world.host.pulls.find((p) => p.id !== bot.id);
		const shown = world.host.pulls.find((p) => p.id === bot.id);
		expect(shown?.comments).toHaveLength(1);
		expect(shown?.comments[0]).toContain(mine?.url ?? 'no draft');
		expect(shown?.open).toBe(true);
		// a later run updates its own draft and says nothing more on the bot's
		await world.tracker.addSignal('1', 'go');
		await buildFeature(deps(world), setup(world), '1');
		expect(world.host.pulls.find((p) => p.id === bot.id)?.comments).toHaveLength(1);
	});

	it('builds nothing and says why when the line names no branch', async () => {
		const world = makeWorld();
		await fromBot(world, 'A Feature.\n\n**Base:** a..b\n');
		const outcome = await buildFeature(deps(world), setup(world), '1');
		expect(outcome.kind).toBe('nothing');
		expect(world.host.pushes).toEqual([]);
		expect(world.tracker.items.get('1')?.signals).toContain('needsInfo');
		expect(world.tracker.said('1').join('\n')).toContain('a..b');
	});
});

describe('the Status note', () => {
	// each Session's sight of the Feature's note, as a person reading the Tracker would see it then
	const watch = (world: World, id: string): (string | undefined)[] => {
		const seen: (string | undefined)[] = [];
		world.settle = () => {
			seen.push(world.tracker.note(id));
			return undefined;
		};
		return seen;
	};

	// the comments on the item, the Status note among them
	const all = (world: World, id: string) =>
		world.tracker.items.get(id)?.comments.map((c) => c.body) ?? [];

	it('reads Building while the build runs, then Draft PR open with the link, and stays one comment', async () => {
		const world = makeWorld();
		const seen = watch(world, '1');
		await buildFeature(deps(world), setup(world), '1');

		expect(seen.length).toBeGreaterThan(0);
		for (const note of seen) {
			expect(note?.startsWith('<!-- nightjar:status -->\n**Building**: ')).toBe(true);
		}
		const note = world.tracker.note('1') ?? '';
		const url = world.host.pulls[0]?.url ?? 'no draft';
		expect(note.startsWith('<!-- nightjar:status -->\n**Draft PR open**: ')).toBe(true);
		expect(note).toContain('Nightjar built 2 of 2 Tickets into a draft pull request.');
		expect(note).toContain(`**Pull request**: ${url}`);
		// in Build order: #3 waits for #2, though the Feature lists it first
		expect(note).toContain('- #2 Share the function: built\n- #3 Use it in marks: built');
		expect(note).toContain(`1. Review the draft pull request ${url}.`);
		// the last Session that built
		expect(note).toContain(
			'Logbook: nightjar ui → #1 · session session-2 (on the machine that ran it)'
		);
		expect(note.endsWith(FOOTER)).toBe(true);
		// the note is the only comment: a build that asks nothing of a person posts none
		expect(all(world, '1')).toEqual([note]);
		expect(world.tracker.said('1')).toEqual([]);
	});

	it('edits the same note when the Feature is built again', async () => {
		const world = makeWorld();
		world.acts['3'] = 'ask';
		await buildFeature(deps(world), setup(world), '1');
		const posted = world.tracker.said('1');
		expect(posted).toHaveLength(1);
		world.acts['3'] = 'build';
		await world.tracker.removeSignal('3', 'needsInfo');
		await world.tracker.addSignal('3', 'ready');
		await world.tracker.removeSignal('1', 'needsInfo');
		await world.tracker.addSignal('1', 'go');
		await buildFeature(deps(world), setup(world), '1');

		const notes = all(world, '1').filter((body) => body.startsWith('<!-- nightjar:status -->'));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain('Nightjar built 2 of 2 Tickets into a draft pull request.');
		expect(world.tracker.said('1')).toEqual(posted);
	});

	it('leaves the Next step to the comment that hands the Feature to a person', async () => {
		const world = makeWorld();
		world.acts['3'] = 'ask';
		await buildFeature(deps(world), setup(world), '1');
		const note = world.tracker.note('1') ?? '';
		expect(note).toContain(
			'**Draft PR open**: Nightjar built 1 of 2 Tickets into a draft pull request.'
		);
		expect(note).toContain('- #3 Use it in marks: waiting, needs info');
		expect(note).not.toContain('**Next step**');
		expect(world.tracker.said('1')[0]).toContain('**Next step**');
	});

	it('puts the note of a Lone issue on the issue itself, with no Ticket list', async () => {
		const world = makeWorld();
		world.tracker.add({ id: '9', title: 'Fix the typo', assignees: ['ann'], signals: ['go'] });
		const seen = watch(world, '9');
		await buildFeature(deps(world), setup(world), '9');

		expect(seen[0]).toContain('**Building**');
		const note = world.tracker.note('9') ?? '';
		expect(note).toContain(
			'**Draft PR open**: Nightjar built this issue into a draft pull request.'
		);
		expect(note).not.toContain('**Tickets**');
		expect(all(world, '9')).toEqual([note]);
	});

	it('never hands the note to the Coding agent as a Trusted comment', async () => {
		const world = makeWorld();
		world.tracker.say('1', { author: 'ann', body: 'Keep the old name.', trusted: true });
		await buildFeature(deps(world), setup(world), '1');
		await world.tracker.addSignal('1', 'go');
		await buildFeature(deps(world), setup(world), '1');
		const asked = askedOf(world, 'build');
		expect(asked.length).toBeGreaterThan(0);
		for (const req of asked) {
			expect(req.featureComments.map((c) => c.body)).toEqual(['Keep the old name.']);
		}
	});

	it('gives a Tracker without statusNote the same comments as before, and no note', async () => {
		const withNote = makeWorld();
		withNote.acts['3'] = 'ask';
		await buildFeature(deps(withNote), setup(withNote), '1');

		const without = makeWorld();
		without.acts['3'] = 'ask';
		const { statusNote: _gone, ...older } = without.tracker;
		await buildFeature({ ...deps(without), tracker: older }, setup(without), '1');

		expect(without.tracker.note('1')).toBeUndefined();
		for (const id of ['1', '2', '3']) {
			expect(all(without, id)).toEqual(withNote.tracker.said(id));
		}
	});

	it('goes on building when the note cannot be written', async () => {
		const world = makeWorld();
		const said: string[] = [];
		const { statusNote: _works, ...rest } = world.tracker;
		const tracker = {
			...rest,
			statusNote: () => Promise.reject(new Error('the Tracker is down'))
		};
		const say = (line: string) => {
			said.push(line);
		};
		const got = await buildFeature({ ...deps(world), tracker, say }, setup(world), '1');
		expect(got.kind).toBe('pull');
		const failed = said.filter((l) => l.includes('could not write its Status note'));
		// the start, each Ticket's start and end, and the pull request
		expect(failed).toHaveLength(6);
		expect(new Set(failed)).toEqual(
			new Set(['#1: could not write its Status note: the Tracker is down'])
		);
		expect(world.tracker.note('1')).toBeUndefined();
	});

	describe('while the Feature builds', () => {
		// every write of the Feature's note, in order
		const writes = (world: World): string[] => {
			const seen: string[] = [];
			const write = world.tracker.statusNote;
			world.tracker.statusNote = (id, body) => {
				seen.push(body);
				return write(id, body);
			};
			return seen;
		};

		// the line a note opens with, under its marker
		const headlineOf = (note: string) => note.split('\n')[1] ?? '';

		// three Tickets, #3 waiting for #2, so the Build order is 2, 3, 4
		const threeTickets = (world: World) => {
			world.tracker.add({ id: '4', title: 'Name it', signals: ['ready'] });
			world.tracker.add({
				id: '1',
				title: 'One escape',
				assignees: ['ann'],
				signals: ['go'],
				children: ['3', '2', '4']
			});
		};

		it('rewrites the one note as each Ticket starts and ends, naming the Ticket', async () => {
			const world = makeWorld();
			threeTickets(world);
			const seen = writes(world);
			await buildFeature(deps(world), setup(world), '1');

			expect(seen.map(headlineOf)).toEqual([
				'**Building**: Nightjar picked this Feature up and is building it.',
				'**Building**: Ticket 1 of 3: Share the function',
				'**Building**: Ticket 1 of 3 built: Share the function',
				'**Building**: Ticket 2 of 3: Use it in marks',
				'**Building**: Ticket 2 of 3 built: Use it in marks',
				'**Building**: Ticket 3 of 3: Name it',
				'**Building**: Ticket 3 of 3 built: Name it',
				expect.stringContaining('**Draft PR open**: ')
			]);
			// never a comment of its own: the note is the Feature's only comment
			expect(all(world, '1')).toEqual([world.tracker.note('1')]);
			expect(world.tracker.said('1')).toEqual([]);
		});

		it('lists every Ticket with its state, in Build order, at each update', async () => {
			const world = makeWorld();
			threeTickets(world);
			const seen = writes(world);
			await buildFeature(deps(world), setup(world), '1');

			const list = (n: number) => /\*\*Tickets\*\*\n\n([\s\S]*?)\n\n/.exec(seen[n] ?? '')?.[1];
			expect(list(0)).toBe(
				'- #2 Share the function: waiting, not reached\n- #3 Use it in marks: waiting, blocked by #2\n- #4 Name it: waiting, not reached'
			);
			expect(list(1)).toBe(
				'- #2 Share the function: building\n- #3 Use it in marks: waiting, blocked by #2\n- #4 Name it: waiting, not reached'
			);
			expect(list(2)).toBe(
				'- #2 Share the function: built\n- #3 Use it in marks: waiting, not reached\n- #4 Name it: waiting, not reached'
			);
			expect(list(3)).toBe(
				'- #2 Share the function: built\n- #3 Use it in marks: building\n- #4 Name it: waiting, not reached'
			);
			expect(list(5)).toBe(
				'- #2 Share the function: built\n- #3 Use it in marks: built\n- #4 Name it: building'
			);
			expect(list(7)).toBe(
				'- #2 Share the function: built\n- #3 Use it in marks: built\n- #4 Name it: built'
			);
		});

		it('shows a Ticket that needs a person among the Tickets of the next update', async () => {
			const world = makeWorld();
			threeTickets(world);
			world.acts['2'] = 'ask';
			const seen = writes(world);
			await buildFeature(deps(world), setup(world), '1');

			// #3 waits for #2, so #4 is the Ticket built next
			const later = seen.find((n) => headlineOf(n).includes('Ticket 3 of 3: Name it')) ?? '';
			expect(later).toContain('- #2 Share the function: waiting, needs info');
			expect(later).toContain('- #4 Name it: building');
		});

		it('says in the headline that the Session is tried again after a passing fault, and which try', async () => {
			const world = makeWorld();
			world.acts['2'] = 'down';
			const seen = writes(world);
			await buildFeature(deps(world), setup(world), '1');

			expect(world.waits).toEqual([30_000, 120_000]);
			expect(seen.map(headlineOf).slice(0, 4)).toEqual([
				'**Building**: Nightjar picked this Feature up and is building it.',
				'**Building**: Ticket 1 of 2: Share the function',
				'**Building**: Ticket 1 of 2: Share the function, retrying after a fault (try 2 of 3)',
				'**Building**: Ticket 1 of 2: Share the function, retrying after a fault (try 3 of 3)'
			]);
			// the retries post nothing: the Feature's one comment is the end of the run, built nothing
			expect(world.tracker.said('1')).toHaveLength(1);
		});

		it('names no Ticket of a Lone issue, which is its own', async () => {
			const world = makeWorld();
			world.tracker.add({ id: '9', title: 'Fix the typo', assignees: ['ann'], signals: ['go'] });
			world.acts['9'] = 'flaky';
			const seen = writes(world);
			await buildFeature(deps(world), setup(world), '9');

			expect(seen.map(headlineOf).slice(1, 3)).toEqual([
				'**Building**: Nightjar is building this issue.',
				'**Building**: Nightjar is building this issue, retrying after a fault (try 2 of 3).'
			]);
			for (const note of seen) expect(note).not.toContain('**Tickets**');
			expect(all(world, '9')).toEqual([world.tracker.note('9')]);
		});
	});
});
