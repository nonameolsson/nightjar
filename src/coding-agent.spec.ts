// The Coding agent module over a fake Session: the request each kind of work sends, and how each Session's end reads.
import { describe, expect, it } from 'vitest';
import {
	codingAgent,
	type AgentSetup,
	type CodingAgent,
	type FixRequest,
	type ReviewRequest,
	type StepRequest
} from './coding-agent.js';
import {
	sessionArgs,
	type Session,
	type SessionRequest,
	type SessionResult,
	type Settled
} from './session.js';
import type { Feature, Ticket } from './tracker.js';
import type { StepConfig } from './workflow.js';

const feature: Feature = { id: '1', title: 'One escape', body: 'Escape once.' };
const ticket: Ticket = {
	id: '2',
	title: 'Share the function',
	body: 'Move it.\n\n**Model:** Opus\n**Effort:** max',
	open: true,
	signals: ['ready'],
	blockedBy: []
};
const plain: Ticket = { ...ticket, id: '3', body: 'Use it.' };
const at = { branch: 'factory/1-one-escape', folder: '/w/1-one-escape', base: 'origin/main' };

const SETUP: AgentSetup = {
	root: '/repo',
	check: 'make check',
	allowedCommands: ['make test'],
	allowApiKey: false,
	env: { PATH: '/bin' },
	portEnv: { WEB_PORT: '4500' },
	limits: { ticketMinutes: 60, reviewMinutes: 10, fixRounds: 3 }
};

// A Session that answers every request with `settled`, keeping each request it was sent.
function fakeSession(settled: Settled, onCall: () => void = () => undefined) {
	const sent: SessionRequest[] = [];
	const session: Session = (req): Promise<SessionResult> => {
		sent.push(req);
		onCall();
		return Promise.resolve({ ...settled, sessionId: req.resume ?? req.sessionId });
	};
	return { sent, session };
}

const done = (output: unknown): Settled => ({ kind: 'done', costUsd: 2.5, output });

// the sandbox of a Session with no network: on, auto-allowing nothing, and never run around
const SEALED = {
	enabled: true,
	failIfUnavailable: true,
	allowUnsandboxedCommands: false,
	autoAllowBashIfSandboxed: false,
	network: { allowedDomains: [] }
};

const permissions = (req: SessionRequest | undefined) =>
	(req?.settings as { permissions: Record<string, string[]> }).permissions;

const buildRequest = (over: Partial<{ ticket: Ticket }> = {}) => ({
	kind: 'build' as const,
	at,
	sessionId: 's-1',
	feature,
	ticket: over.ticket ?? plain,
	featureComments: [],
	ticketComments: [],
	built: [],
	budgetUsd: 15
});

describe('a build', () => {
	it('starts a new Session in the worktree on the Ticket, with the build tools and settings', async () => {
		const { sent, session } = fakeSession(done({ outcome: 'built', summary: 'Built it' }));
		await codingAgent({ ...SETUP, rules: 'Tabs.' }, session).build(buildRequest());
		const req = sent[0];
		expect(req?.cwd).toBe('/w/1-one-escape');
		expect(req?.sessionId).toBe('s-1');
		expect(req?.resume).toBeUndefined();
		expect(req?.prompt).toContain('# Your Ticket: #3 Share the function\n\nUse it.');
		expect(req?.prompt).toContain('# Rules of this repo\n\nTabs.');
		expect(req?.prompt).toContain('`make test`');
		expect(req?.tools).toContain('Edit');
		expect(req?.budgetUsd).toBe(15);
		expect(req?.minutes).toBe(60);
		expect(req?.log).toBe('/repo/.factory/logs/s-1.jsonl');
		expect(req?.allowApiKey).toBe(false);
		expect(req?.env).toEqual({ PATH: '/bin', WEB_PORT: '4500' });
		expect(JSON.stringify(req?.settings)).toContain('Bash(make test)');
		expect(req?.settings).toMatchObject({ disableAllHooks: true, sandbox: SEALED });
	});

	it('loads the repo plugins from the worktree', async () => {
		const { sent, session } = fakeSession(done({ outcome: 'built', summary: 'Built it' }));
		await codingAgent({ ...SETUP, plugins: ['.claude'] }, session).build(buildRequest());
		expect(sent[0]?.plugins).toEqual(['/w/1-one-escape/.claude']);
	});

	it('never loosens the deny rules, whatever commands the repo allows', async () => {
		const { sent, session } = fakeSession(done({ outcome: 'built', summary: 'Built it' }));
		const loosening = ['make test', 'git push *', 'gh *'];
		await codingAgent({ ...SETUP, allowedCommands: loosening }, session).build(buildRequest());
		const { allow, deny } = permissions(sent[0]);
		expect(allow).toContain('Bash(make test)');
		expect(deny).toEqual(
			expect.arrayContaining(['Bash(git push *)', 'Bash(git commit *)', 'Bash(gh *)'])
		);
	});

	it('reads a built answer', async () => {
		const { session } = fakeSession(done({ outcome: 'built', summary: 'Built it' }));
		expect(await codingAgent(SETUP, session).build(buildRequest())).toEqual({
			kind: 'built',
			summary: 'Built it',
			sessionId: 's-1',
			costUsd: 2.5
		});
	});

	it('reads questions', async () => {
		const questions = [{ question: 'Which file?', recommendation: 'marks.ts' }];
		const { session } = fakeSession(done({ outcome: 'questions', summary: '', questions }));
		expect(await codingAgent(SETUP, session).build(buildRequest())).toEqual({
			kind: 'questions',
			questions,
			sessionId: 's-1',
			costUsd: 2.5
		});
	});

	it('fails on an answer in a shape not known', async () => {
		const { session } = fakeSession(done({ outcome: 'maybe' }));
		expect(await codingAgent(SETUP, session).build(buildRequest())).toEqual({
			kind: 'failed',
			why: 'it answered in a shape not known',
			sessionId: 's-1',
			costUsd: 2.5
		});
	});
});

const looks: StepConfig = {
	name: 'looks',
	point: 'afterAllTickets',
	prompt: 'Look at it.',
	until: 'it looks right',
	model: 'opus',
	effort: 'max'
};
const extras = {
	allowedCommands: ['npx playwright *'],
	allowedTools: ['mcp__pw'],
	localNetwork: true
};

const fixRequest = (of: FixRequest['of'] = { kind: 'build' }): FixRequest => ({
	kind: 'fix',
	at,
	of,
	resume: 's-1',
	round: 2,
	tail: 'lint: 1 problem',
	budgetUsd: 9.5
});

describe('a fix round', () => {
	it('resumes the Session of the build, with the check and its failing tail', async () => {
		const { sent, session } = fakeSession(done({ outcome: 'built', summary: 'Fixed it' }));
		await codingAgent(SETUP, session).fix(fixRequest());
		const req = sent[0];
		expect(req?.resume).toBe('s-1');
		expect(req?.sessionId).toBe('s-1');
		expect(req?.prompt).toMatch(
			/^The repo's check, `make check`, fails after your work\. This is fix round 2 of 3\./
		);
		expect(req?.prompt).toMatch(/\n\nlint: 1 problem$/);
		expect(req?.budgetUsd).toBe(9.5);
		expect(req?.minutes).toBe(60);
		expect(req?.log).toBe('/repo/.factory/logs/s-1.jsonl');
		expect(req?.tools).not.toContain('mcp__pw');
	});

	it('passes the sandboxed settings of the build with --resume', async () => {
		const { sent, session } = fakeSession(done({ outcome: 'built', summary: 'Built it' }));
		const agent = codingAgent(SETUP, session);
		await agent.build(buildRequest());
		await agent.fix(fixRequest());
		const [built, fixed] = sent.map(sessionArgs);
		const value = (args: string[] | undefined, flag: string) =>
			args?.[args.indexOf(flag) + 1] ?? '';
		expect(value(fixed, '--resume')).toBe('s-1');
		expect(value(fixed, '--settings')).toBe(value(built, '--settings'));
		expect(JSON.parse(value(fixed, '--settings'))).toMatchObject({
			disableAllHooks: true,
			sandbox: SEALED
		});
	});

	it("resumes a Step's Session with the Step's tools, commands and local network", async () => {
		const { sent, session } = fakeSession(
			done({ outcome: 'done', summary: 'Fixed it', untilHolds: true, left: [], blocker: '' })
		);
		await codingAgent(SETUP, session).fix(fixRequest({ kind: 'step', step: looks, extras }));
		const req = sent[0];
		expect(req?.tools).toContain('mcp__pw');
		expect(JSON.stringify(req?.settings)).toContain('Bash(npx playwright *)');
		expect(req?.settings).toMatchObject({
			sandbox: { failIfUnavailable: true, allowUnsandboxedCommands: false }
		});
		expect(req?.schema).toHaveProperty('properties.untilHolds');
	});

	describe('of the Pull checks', () => {
		const report = 'CI / test: failed\n\njob test, step Run npm test\n\nError: TZ is not set';
		const diff = { text: 'diff --git a/ci.ts b/ci.ts\n+tz', truncated: false };
		const pullChecks = (over: Partial<FixRequest> = {}): FixRequest => ({
			...fixRequest({ kind: 'pullChecks' }),
			tail: report,
			...over
		});
		const freshRequest = (truncated = false): FixRequest =>
			pullChecks({
				of: { kind: 'pullChecks', fresh: { feature, diff: { ...diff, truncated } } },
				resume: 'new-1'
			});
		const answer = done({ outcome: 'built', summary: 'Set TZ' });

		it('resumes the Session of the head commit, with the failures', async () => {
			const { sent, session } = fakeSession(answer);
			await codingAgent(SETUP, session).fix(pullChecks());
			const req = sent[0];
			expect(req?.resume).toBe('s-1');
			expect(req?.prompt).toContain('its Pull checks fail');
			expect(req?.prompt).toContain(report);
			expect(req?.prompt).not.toContain('# The Feature');
		});

		it("starts a new Session when the head commit's is gone, with the Feature, the branch's diff and each failure", async () => {
			const { sent, session } = fakeSession(answer);
			const got = await codingAgent({ ...SETUP, rules: 'Tabs.' }, session).fix(freshRequest());
			const req = sent[0];
			expect(req?.resume).toBeUndefined();
			expect(req?.sessionId).toBe('new-1');
			expect(req?.log).toBe('/repo/.factory/logs/new-1.jsonl');
			expect(req?.prompt).toContain('# The Feature: #1 One escape\n\nEscape once.');
			expect(req?.prompt).toContain("# The branch's diff against origin/main");
			expect(req?.prompt).toContain('```diff\ndiff --git a/ci.ts b/ci.ts\n+tz\n```');
			expect(req?.prompt).toContain(report);
			expect(req?.prompt).toContain('its Pull checks fail');
			expect(req?.prompt).toContain('# Rules of this repo\n\nTabs.');
			expect(req?.prompt).toContain('`make test`');
			expect(got).toEqual({ kind: 'fixed', summary: 'Set TZ', sessionId: 'new-1', costUsd: 2.5 });
		});

		it('keeps the deny rules and the build tools in a new Session', async () => {
			const { sent, session } = fakeSession(answer);
			await codingAgent({ ...SETUP, allowedCommands: ['make test', 'git push *'] }, session).fix(
				freshRequest()
			);
			const { allow, deny } = permissions(sent[0]);
			expect(allow).toContain('Bash(make test)');
			expect(deny).toEqual(expect.arrayContaining(['Bash(git push *)', 'Bash(git commit *)']));
			expect(sent[0]?.tools).toContain('Edit');
		});

		it("says when the diff is cut, and runs a new Session on the repo's defaults", async () => {
			const { sent, session } = fakeSession(answer);
			await codingAgent({ ...SETUP, defaults: { model: 'sonnet', effort: 'high' } }, session).fix(
				freshRequest(true)
			);
			expect(sent[0]?.prompt).toContain('It is cut here; the rest is in git.');
			expect(sent[0]?.model).toBe('sonnet');
			expect(sent[0]?.effort).toBe('high');
		});

		it('leaves the model of a resumed Session alone', async () => {
			const { sent, session } = fakeSession(answer);
			await codingAgent({ ...SETUP, defaults: { model: 'sonnet', effort: 'high' } }, session).fix(
				pullChecks()
			);
			expect(sent[0]?.model).toBeUndefined();
		});
	});

	it('reads a fix that finished', async () => {
		const { session } = fakeSession(done({ outcome: 'built', summary: 'Fixed it' }));
		expect(await codingAgent(SETUP, session).fix(fixRequest())).toEqual({
			kind: 'fixed',
			summary: 'Fixed it',
			sessionId: 's-1',
			costUsd: 2.5
		});
	});

	it('reads a build fix that turned to questions as giving up', async () => {
		const questions = [{ question: 'Which file?', recommendation: 'marks.ts' }];
		const { session } = fakeSession(done({ outcome: 'questions', summary: '', questions }));
		expect(await codingAgent(SETUP, session).fix(fixRequest())).toEqual({
			kind: 'gaveUp',
			sessionId: 's-1',
			costUsd: 2.5
		});
	});

	it("reads a Step's fix that reported itself blocked as giving up", async () => {
		const { session } = fakeSession(
			done({ outcome: 'blocked', summary: '', untilHolds: false, left: [], blocker: 'Which page?' })
		);
		const got = await codingAgent(SETUP, session).fix(
			fixRequest({ kind: 'step', step: looks, extras })
		);
		expect(got).toEqual({ kind: 'gaveUp', sessionId: 's-1', costUsd: 2.5 });
	});

	it('fails on an answer in a shape not known', async () => {
		const { session } = fakeSession(done({ outcome: 'done', summary: 'Fixed it' }));
		const got = await codingAgent(SETUP, session).fix(fixRequest());
		expect(got).toEqual({
			kind: 'failed',
			why: 'it answered in a shape not known',
			sessionId: 's-1',
			costUsd: 2.5
		});
	});
});

const stepRequest = (over: Partial<StepRequest> = {}): StepRequest => ({
	kind: 'step',
	at,
	sessionId: 's-1',
	workflow: 'ui',
	step: looks,
	extras,
	round: 1,
	rounds: 3,
	feature,
	ticket: null,
	notes: '/w/1-one-escape/.factory/notes',
	left: [],
	budgetUsd: 4,
	...over
});

const stepDone = {
	outcome: 'done',
	summary: 'Looked',
	untilHolds: false,
	left: ['the footer'],
	blocker: ''
};

describe('a Step round', () => {
	it("starts the Step's Session on its prompt, with the Workflow's tools, commands and local network", async () => {
		const { sent, session } = fakeSession(done(stepDone));
		const diff = { text: '+a', truncated: false };
		await codingAgent(SETUP, session).step(stepRequest({ diff }));
		const req = sent[0];
		expect(req?.resume).toBeUndefined();
		expect(req?.prompt).toMatch(/^Nobody is at the keyboard/);
		expect(req?.prompt).toContain('never ask a question in chat');
		expect(req?.prompt).toContain('# Your Step\n\nLook at it.');
		expect(req?.prompt).toContain('git diff origin/main...HEAD');
		expect(req?.prompt).toContain('You run Step `looks` of Workflow `ui`');
		expect(req?.prompt).toContain('`make test`, `npx playwright *`');
		expect(req?.prompt).toContain('Notes folder: `.factory/notes`.');
		expect(req?.prompt).toContain("# The Feature's diff against origin/main");
		expect(req?.prompt).toContain('up to 3 rounds');
		expect(req?.tools).toContain('mcp__pw');
		expect(JSON.stringify(req?.settings)).toContain('Bash(npx playwright *)');
		expect(req?.schema).toHaveProperty('properties.untilHolds');
		expect([req?.budgetUsd, req?.minutes]).toEqual([4, 60]);
	});

	it('keeps the deny rules and opens only localhost to a Workflow that asks for its network', async () => {
		const { sent, session } = fakeSession(done(stepDone));
		await codingAgent(SETUP, session).step(stepRequest());
		expect(permissions(sent[0]).deny).toEqual(
			expect.arrayContaining([
				'Bash(git commit *)',
				'Bash(git push *)',
				'Bash(git switch *)',
				'Bash(gh *)',
				'Bash(curl *)',
				'WebFetch'
			])
		);
		expect(sent[0]?.settings).toMatchObject({
			sandbox: {
				enabled: true,
				failIfUnavailable: true,
				allowUnsandboxedCommands: false,
				network: { allowedDomains: ['localhost', '127.0.0.1'] }
			}
		});
	});

	it('resumes it for a later round, with what the last round left', async () => {
		const { sent, session } = fakeSession(done(stepDone));
		await codingAgent(SETUP, session).step(stepRequest({ round: 2, left: ['the footer'] }));
		const req = sent[0];
		expect(req?.resume).toBe('s-1');
		expect(req?.prompt).toBe(
			'Round 2 of 3. This does not hold yet: it looks right\n\nLeft from the last round:\n- the footer\n\nThe same rules hold: nobody is at the keyboard, do not commit, and answer with the same structured output.'
		);
	});

	it('reads a round that is done', async () => {
		const { session } = fakeSession(done(stepDone));
		expect(await codingAgent(SETUP, session).step(stepRequest())).toEqual({
			kind: 'done',
			summary: 'Looked',
			left: ['the footer'],
			untilHolds: false,
			sessionId: 's-1',
			costUsd: 2.5
		});
	});

	it('holds a Step without an until after its one round, whatever the answer says', async () => {
		const { session } = fakeSession(done(stepDone));
		const once = { ...looks, until: undefined };
		const got = await codingAgent(SETUP, session).step(stepRequest({ step: once }));
		expect(got).toMatchObject({ kind: 'done', untilHolds: true });
	});

	it('reads a Step that reported itself blocked', async () => {
		const { session } = fakeSession(
			done({ ...stepDone, outcome: 'blocked', blocker: 'Which page?' })
		);
		expect(await codingAgent(SETUP, session).step(stepRequest())).toEqual({
			kind: 'blocked',
			blocker: 'Which page?',
			sessionId: 's-1',
			costUsd: 2.5
		});
	});

	it('fails on an answer in a shape not known', async () => {
		const { session } = fakeSession(done({ outcome: 'built', summary: 'Built it' }));
		expect(await codingAgent(SETUP, session).step(stepRequest())).toEqual({
			kind: 'failed',
			why: 'it answered in a shape not known',
			sessionId: 's-1',
			costUsd: 2.5
		});
	});
});

const reviewRequest = (): ReviewRequest => ({
	kind: 'review',
	at,
	sessionId: 's-9',
	feature,
	tickets: [ticket, plain],
	budgetUsd: 3
});

const verdict = {
	verdict: 'changes',
	summary: 'One bug.',
	issues: [{ file: 'a.ts', line: 2, problem: 'off by one' }]
};

describe('the review', () => {
	it('starts a reading Session on the Feature, its Tickets and the diff against the base', async () => {
		const { sent, session } = fakeSession(done(verdict));
		await codingAgent({ ...SETUP, rules: 'Tabs.' }, session).review(reviewRequest());
		const req = sent[0];
		expect(req?.cwd).toBe('/w/1-one-escape');
		expect(req?.sessionId).toBe('s-9');
		expect(req?.resume).toBeUndefined();
		expect(req?.prompt).toContain('Review `git diff origin/main...HEAD` against:');
		expect(req?.prompt).toContain('- #2 Share the function\n\nMove it.');
		expect(req?.prompt).toContain('- #3 Share the function\n\nUse it.');
		expect(req?.prompt).toContain('# Rules of this repo\n\nTabs.');
		expect(req?.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
		expect(JSON.stringify(req?.settings)).not.toContain('make test');
		expect(req?.schema).toHaveProperty('properties.verdict');
		expect([req?.budgetUsd, req?.minutes]).toEqual([3, 10]);
		expect(req?.log).toBe('/repo/.factory/logs/s-9.jsonl');
	});

	it('reads the review', async () => {
		const { session } = fakeSession(done(verdict));
		expect(await codingAgent(SETUP, session).review(reviewRequest())).toEqual({
			kind: 'reviewed',
			review: verdict,
			sessionId: 's-9',
			costUsd: 2.5
		});
	});

	it('fails on an answer in a shape not known', async () => {
		const { session } = fakeSession(done({ verdict: 'maybe', summary: '', issues: [] }));
		expect(await codingAgent(SETUP, session).review(reviewRequest())).toEqual({
			kind: 'failed',
			why: 'it answered in a shape not known',
			sessionId: 's-9',
			costUsd: 2.5
		});
	});
});

type Call = (agent: CodingAgent) => Promise<{ readonly kind: string; readonly sessionId: string }>;

// Each kind of work, with the Session its request starts or resumes.
const kinds: [string, Call, string][] = [
	['a build', (agent) => agent.build(buildRequest()), 's-1'],
	['a fix round', (agent) => agent.fix(fixRequest()), 's-1'],
	[
		"a Step's fix round",
		(agent) => agent.fix(fixRequest({ kind: 'step', step: looks, extras })),
		's-1'
	],
	['a Step round', (agent) => agent.step(stepRequest()), 's-1'],
	['the review', (agent) => agent.review(reviewRequest()), 's-9']
];

const pullChecksFix = (fresh: boolean): FixRequest => ({
	...fixRequest({
		kind: 'pullChecks',
		...(fresh ? { fresh: { feature, diff: { text: '+a', truncated: false } } } : {})
	}),
	tail: 'CI / test: failed'
});

// Every kind of Session, each with the sandbox its commands run in.
const sandboxed: [string, Call, object][] = [
	...kinds
		.filter(([name]) => !name.includes('Step'))
		.map(([name, call]): [string, Call, object] => [name, call, SEALED]),
	['a Pull-check fix', (agent) => agent.fix(pullChecksFix(false)), SEALED],
	['a fresh Pull-check fix', (agent) => agent.fix(pullChecksFix(true)), SEALED],
	[
		'a Step round of a Workflow without localNetwork',
		(agent) => agent.step(stepRequest({ extras: { ...extras, localNetwork: false } })),
		SEALED
	],
	[
		"a Step's fix round of a Workflow without localNetwork",
		(agent) =>
			agent.fix(fixRequest({ kind: 'step', step: looks, extras: { localNetwork: false } })),
		SEALED
	],
	[
		"a localNetwork Step's fix round",
		(agent) => agent.fix(fixRequest({ kind: 'step', step: looks, extras })),
		{ ...SEALED, network: { allowedDomains: ['localhost', '127.0.0.1'] } }
	]
];

describe.each(sandboxed)('%s', (_name, call, sandbox) => {
	it('runs in the sandbox, failing closed, with no hooks', async () => {
		const { sent, session } = fakeSession(done({}));
		await call(codingAgent(SETUP, session));
		expect(sent[0]?.settings).toMatchObject({ disableAllHooks: true, sandbox });
	});
});

describe.each(kinds)('how %s ends besides its answer', (_name, call, sessionId) => {
	const ended = async (settled: Settled, setup: AgentSetup = SETUP, onCall?: () => void) => {
		const { session } = fakeSession(settled, onCall);
		return call(codingAgent(setup, session));
	};

	it('fails with why a stopped Session stopped, and its cost', async () => {
		expect(await ended({ kind: 'stopped', costUsd: 15.2, why: 'it reached its budget' })).toEqual({
			kind: 'failed',
			why: 'it reached its budget',
			sessionId,
			costUsd: 15.2
		});
	});

	it('pauses on the usage limit, with when it resets', async () => {
		expect(await ended({ kind: 'rate-limited', resetsAt: 1793390400 })).toEqual({
			kind: 'paused',
			why: "the plan's usage limit was reached; it resets at 2026-10-30T20:00:00.000Z",
			sessionId,
			costUsd: 0
		});
	});

	it('pauses on the usage limit when no reset time is known', async () => {
		expect(await ended({ kind: 'rate-limited', resetsAt: null })).toEqual({
			kind: 'paused',
			why: "the plan's usage limit was reached",
			sessionId,
			costUsd: 0
		});
	});

	it('pauses on a Session that would bill an API key', async () => {
		expect(await ended({ kind: 'api-key' })).toEqual({
			kind: 'paused',
			why: 'the session billed an API key; unset ANTHROPIC_API_KEY or pass --use-api-key',
			sessionId,
			costUsd: 0
		});
	});

	it('is aborted by a stop, whatever the Session said, and keeps its cost', async () => {
		const stop = new AbortController();
		const setup = { ...SETUP, signal: stop.signal };
		const settled: Settled = { kind: 'stopped', costUsd: 1.5, why: 'stopped by a person' };
		expect(await ended(settled, setup, () => stop.abort())).toEqual({
			kind: 'aborted',
			sessionId,
			costUsd: 1.5
		});
	});

	it("runs in the Feature's worktree, on the machine's environment and the reserved ports", async () => {
		const { sent, session } = fakeSession(done({}));
		await call(codingAgent({ ...SETUP, allowApiKey: true }, session));
		expect(sent[0]?.cwd).toBe('/w/1-one-escape');
		expect(sent[0]?.env).toEqual({ PATH: '/bin', WEB_PORT: '4500' });
		expect(sent[0]?.allowApiKey).toBe(true);
	});

	it('passes the stop signal to the Session', async () => {
		const stop = new AbortController();
		const { sent, session } = fakeSession(done({}));
		await call(codingAgent({ ...SETUP, signal: stop.signal }, session));
		expect(sent[0]?.signal).toBe(stop.signal);
	});
});

interface Own {
	readonly model?: string;
	readonly effort?: string;
}

const ticketBody = (own: Own) =>
	[
		'Use it.',
		...(own.model ? [`**Model:** ${own.model}`] : []),
		...(own.effort ? [`**Effort:** ${own.effort}`] : [])
	].join('\n');

// Each kind of work whose own setting picks its model, given that setting.
const owners: [
	string,
	(own: Own) => { readonly setup?: Partial<AgentSetup>; readonly call: Call }
][] = [
	[
		"a build, by its Ticket's Model and Effort lines",
		(own) => ({
			call: (agent) => agent.build(buildRequest({ ticket: { ...plain, body: ticketBody(own) } }))
		})
	],
	[
		"a Step round, by the Step's config",
		(own) => ({ call: (agent) => agent.step(stepRequest({ step: { ...looks, ...own } })) })
	],
	[
		"a Step's fix round, by the Step's config",
		(own) => ({
			call: (agent) => agent.fix(fixRequest({ kind: 'step', step: { ...looks, ...own }, extras }))
		})
	],
	[
		"the review, by factory.json's review settings",
		(own) => ({ setup: { review: own }, call: (agent) => agent.review(reviewRequest()) })
	]
];

describe.each(owners)('the model and effort of %s', (_name, work) => {
	const sentWith = async (setup: Partial<AgentSetup>, own: Own) => {
		const { sent, session } = fakeSession(done({}));
		const { setup: its, call } = work(own);
		await call(codingAgent({ ...SETUP, ...its, ...setup }, session));
		return [sent[0]?.model, sent[0]?.effort];
	};
	const defaults = { model: 'haiku', effort: 'low' };
	const unset = { model: undefined, effort: undefined };

	it("is the work's own over the repo's defaults", async () => {
		expect(await sentWith({ defaults }, { model: 'opus', effort: 'max' })).toEqual(['opus', 'max']);
	});

	it("is the CLI flag's over the work's own", async () => {
		const flags = { defaults, model: 'sonnet', effort: 'high' };
		expect(await sentWith(flags, { model: 'opus', effort: 'max' })).toEqual(['sonnet', 'high']);
	});

	it("is the repo's defaults where the work names none", async () => {
		expect(await sentWith({ defaults }, unset)).toEqual(['haiku', 'low']);
	});

	it('is left to Claude Code where nobody names one', async () => {
		expect(await sentWith({}, unset)).toEqual([undefined, undefined]);
	});
});

describe("the model and effort of a build's fix round", () => {
	it('is not named, so the resumed Session keeps its own', async () => {
		const { sent, session } = fakeSession(done({}));
		const setup = {
			...SETUP,
			defaults: { model: 'haiku', effort: 'low' },
			model: 'sonnet',
			effort: 'high'
		};
		await codingAgent(setup, session).fix(fixRequest());
		expect([sent[0]?.model, sent[0]?.effort]).toEqual([undefined, undefined]);
	});
});
