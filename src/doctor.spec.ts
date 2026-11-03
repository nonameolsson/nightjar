// `nightjar doctor` by its output, over a machine of stand-ins for gh, az and claude.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oneEscape } from './fakes/github.js';
import { machine, type Machine, type Tool } from './fakes/machine.js';
import { checkMachine } from './checks.js';
import type { FakeGitHub } from './github/fake-github.js';
import { runNightjar } from './main.js';

let out: string[];
let err: string[];
let m: Machine;
let github: FakeGitHub;
beforeEach(() => {
	out = [];
	err = [];
	github = oneEscape();
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
	vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});
afterEach(() => {
	vi.restoreAllMocks();
	m.remove();
});

const GITHUB = {
	tracker: { type: 'github' },
	codeHost: { type: 'github' },
	check: 'make check',
	allowedCommands: ['make check']
};

async function doctor(
	over: { without?: Tool[]; env?: Record<string, string>; argv?: string[] } = {}
) {
	m = machine(over.without);
	m.writeConfig(GITHUB);
	// a machine without gh has none to answer, whatever a fake GitHub would say
	return start({ ...over, realGh: over.without?.includes('gh') ?? false });
}

function start(over: { env?: Record<string, string>; argv?: string[]; realGh?: boolean } = {}) {
	return runNightjar(over.argv ?? ['doctor'], {
		platform: 'linux',
		cwd: m.root,
		env: { ...m.env, ...over.env },
		...(over.realGh === true ? {} : { gh: github.gh })
	});
}

describe('nightjar doctor', () => {
	it('names each check it passed, and what it would build', async () => {
		expect(await doctor()).toBe(0);
		expect(err).toEqual([]);
		expect(out).toEqual(
			expect.arrayContaining([
				'  ok    API key: none set, so sessions bill your Claude plan',
				`  ok    Node: ${process.versions.node}`,
				`  ok    git checkout: ${m.root}`,
				'  ok    factory.json: read',
				'  ok    Tracker: gh as ann on o/r',
				'  ok    Code host: o/r',
				`  ok    claude: 2.1.314 (Claude Code), ann@x.io, Acme, max plan, claude.ai login, config ${m.env.HOME}/.claude`,
				'  ok    git signing: commits unsigned',
				'nightjar: would build #1 One escape'
			])
		);
		expect(github.calls.filter((c) => c.method !== 'GET')).toEqual([]);
	});

	it('is what --dry-run does', async () => {
		expect(await doctor({ argv: ['--dry-run'] })).toBe(0);
		expect(out).toContain('nightjar: would build #1 One escape');
	});

	it('runs every check when gh and claude are both signed out, and says how to fix each', async () => {
		github.signOut();
		const code = await doctor({ env: { FAKE_CLAUDE_SIGNED_OUT: '1' } });
		expect(code).toBe(2);
		const said = err.join('\n');
		expect(said).toMatch(/FAIL {2}Tracker: .*run `gh auth login`/);
		expect(said).toMatch(/FAIL {2}Code host: .*run `gh auth login`/);
		expect(said).toMatch(
			/FAIL {2}claude: .*not signed in.*type \/login, or pass another --profile/
		);
		// the checks that passed are still listed
		expect(out).toContain('  ok    factory.json: read');
		expect(out.join('\n')).not.toContain('would build');
	});

	it('says where to get gh and claude when they are not installed', async () => {
		const code = await doctor({ without: ['gh', 'claude'] });
		expect(code).toBe(2);
		const said = err.join('\n');
		expect(said).toMatch(/FAIL {2}Tracker: gh is not on the PATH.*https:\/\/cli\.github\.com/);
		expect(said).toMatch(/FAIL {2}claude: claude is not on the PATH.*https:\/\/claude\.com/);
	});

	it('does not ask a signed-in claude when the person chose the API key', async () => {
		const code = await doctor({
			argv: ['doctor', '--use-api-key'],
			env: { ANTHROPIC_API_KEY: 'sk-test', FAKE_CLAUDE_SIGNED_OUT: '1' }
		});
		expect(code).toBe(0);
		expect(out).toContain('  ok    API key: ANTHROPIC_API_KEY chosen');
		expect(m.calls('claude')).not.toContain('auth status');
	});

	it("runs the sessions' own environment through --profile, naming the login it finds", async () => {
		const code = await doctor({
			argv: ['doctor', '--profile', 'work'],
			env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CONFIG_DIR: '/elsewhere' }
		});
		expect(code).toBe(0);
		expect(m.calls('claude')).toContain(
			`auth status --json [dir=${m.env.HOME}/.claude-work token=]`
		);
		expect(out).toContain(
			`  ok    claude: 2.1.314 (Claude Code), ann@x.io, Acme, max plan, claude.ai login, config ${m.env.HOME}/.claude-work`
		);
	});

	it("takes the profile from the person's config.json when --profile is not given", async () => {
		m = machine();
		m.writeConfig(GITHUB);
		mkdirSync(join(m.env.HOME ?? '', '.config', 'nightjar'), { recursive: true });
		writeFileSync(
			join(m.env.HOME ?? '', '.config', 'nightjar', 'config.json'),
			JSON.stringify({ profile: 'work' })
		);
		expect(await start()).toBe(0);
		expect(m.calls('claude')).toContain(`dir=${m.env.HOME}/.claude-work`);
		// and --profile beats it
		expect(await start({ argv: ['doctor', '--profile', 'default'] })).toBe(0);
		expect(m.calls('claude')).toMatch(/auth status --json \[dir= token=\]/);
	});

	it('refuses a repo with no check command, reaching no Tracker', async () => {
		m = machine();
		const { check: _check, ...without } = GITHUB;
		m.writeConfig(without);
		expect(await start()).toBe(2);
		expect(err.join('\n')).toContain(
			'FAIL  factory.json: check: missing: name the command that checks the work'
		);
		expect(out.join('\n')).toContain('  skip  Tracker: needs a usable factory.json');
		expect(github.calls).toEqual([]);
	});

	it('says to run init when there is no factory.json', async () => {
		m = machine();
		expect(await start()).toBe(2);
		expect(err.join('\n')).toContain('run `nightjar init`');
	});

	it('tells an Azure DevOps person to run az login, or set a token', async () => {
		m = machine();
		m.writeConfig({
			...GITHUB,
			tracker: {
				type: 'azure-devops',
				organization: 'contoso',
				project: 'Fab',
				featureType: 'Feature'
			}
		});
		expect(await start({ env: { FAKE_AZ_SIGNED_OUT: '1' } })).toBe(2);
		expect(err.join('\n')).toMatch(/FAIL {2}Tracker: .*az login.*AZURE_DEVOPS_EXT_PAT/);
	});
});

describe('nightjar doctor over Sources', () => {
	const SOURCES = {
		sentry: {
			type: 'sentry',
			template: 'sentry',
			key: 'data.event.issue_id',
			secretEnv: 'SENTRY_HOOK_SECRET'
		},
		'weekly-deps': { type: 'schedule', cron: '0 6 * * 1', template: 'weekly-deps' }
	};

	function withSources(sources: Record<string, unknown> = SOURCES) {
		m = machine();
		m.writeConfig({ ...GITHUB, sources });
	}

	it('lists each Source with its template, and passes when all is as it should be', async () => {
		withSources();
		expect(await start({ env: { SENTRY_HOOK_SECRET: 'whsec' } })).toBe(0);
		expect(err).toEqual([]);
		expect(out).toContain('  ok    Source sentry: sentry, template sentry is in shape');
		expect(out.join('\n')).toMatch(
			/^ {2}ok {4}Source weekly-deps: schedule 0 6 \* \* 1, next due \d{4}-\d\d-\d\d 06:00, template weekly-deps is in shape$/m
		);
	});

	it("prints each schedule's next due time, in local time", async () => {
		withSources({
			'weekly-deps': { type: 'schedule', cron: '0 6 * * 1', template: 'weekly-deps' },
			daily: { type: 'schedule', cron: '@daily', template: 'weekly-deps' }
		});
		// a Tuesday, local noon
		const checked = await checkMachine({
			useApiKey: false,
			env: m.env,
			cwd: m.root,
			failFast: false,
			gh: github.gh,
			now: () => new Date(2026, 10, 3, 12, 0)
		});
		const detail = (name: string) => checked.lines.find((l) => l.source === name)?.detail;
		expect(detail('weekly-deps')).toBe(
			'schedule 0 6 * * 1, next due 2026-11-09 06:00, template weekly-deps is in shape'
		);
		expect(detail('daily')).toBe(
			'schedule @daily, next due 2026-11-04 00:00, template weekly-deps is in shape'
		);
	});

	it('refuses a Source whose secretEnv variable is unset or empty, and names it', async () => {
		withSources();
		for (const env of [{} as Record<string, string>, { SENTRY_HOOK_SECRET: '' }]) {
			err = [];
			expect(await start({ env })).toBe(2);
			expect(err.join('\n')).toMatch(/FAIL {2}Source sentry: SENTRY_HOOK_SECRET is not set/);
			expect(err.join('\n')).toContain('nightjar: a Source cannot run');
		}
		expect(out.join('\n')).toContain('ok    Source weekly-deps');
	});

	it('refuses a webhook Source that names no secretEnv', async () => {
		withSources({ hook: { type: 'webhook', template: 'sentry' } });
		expect(await start()).toBe(2);
		expect(err.join('\n')).toMatch(
			/FAIL {2}Source hook: name the variable that holds its webhook secret/
		);
	});

	it('names what is out of shape in a template, and a template that is not there', async () => {
		withSources({
			bad: { type: 'schedule', cron: '@daily', template: 'bad.md' },
			gone: { type: 'schedule', cron: '@daily', template: 'gone.md' },
			unshipped: { type: 'schedule', cron: '@daily', template: 'nothing-shipped' }
		});
		writeFileSync(join(m.root, 'bad.md'), '# A title\n\n## Ticket 1: No criteria\n');
		expect(await start()).toBe(2);
		const said = err.join('\n');
		expect(said).toMatch(/FAIL {2}Source bad: template bad\.md: .*no acceptance criteria/);
		expect(said).toContain('Source gone: template gone.md: cannot read the template gone.md');
		expect(said).toContain('Source unshipped: template nothing-shipped: Nightjar ships no');
	});

	it('reads a template of the repo by its path from the root', async () => {
		withSources({ own: { type: 'schedule', cron: '@weekly', template: '.nightjar/own.md' } });
		mkdirSync(join(m.root, '.nightjar'));
		writeFileSync(
			join(m.root, '.nightjar', 'own.md'),
			'# {{ date }}\n\n## Ticket 1: Do it\n\n### Acceptance criteria\n\n- [ ] done\n'
		);
		expect(await start()).toBe(0);
		expect(out.join('\n')).toMatch(
			/^ {2}ok {4}Source own: schedule @weekly, next due \d{4}-\d\d-\d\d 00:00, template \.nightjar\/own\.md is in shape$/m
		);
	});

	describe('with a go: true Source', () => {
		const GOING = {
			weekly: { type: 'schedule', cron: '@weekly', template: 'weekly-deps', go: true, owner: 'bob' }
		};

		it('passes when the owner has write access, and says the Source gives the Go', async () => {
			withSources(GOING);
			github.grant('bob', 'write');
			expect(await start()).toBe(0);
			expect(out.join('\n')).toMatch(
				/^ {2}ok {4}Source weekly: schedule @weekly, .*, template weekly-deps is in shape, gives the Go for bob$/m
			);
		});

		it('refuses an owner the Tracker does not trust, as intake does', async () => {
			withSources(GOING);
			github.grant('bob', 'read');
			expect(await start()).toBe(2);
			expect(err.join('\n')).toMatch(
				/FAIL {2}Source weekly: the owner bob is not trusted by the Tracker \(write access on GitHub/
			);
			expect(err.join('\n')).toContain('nightjar: a Source cannot run');
		});

		it("reads the owner from factory.json's trusted list when it has one", async () => {
			m = machine();
			m.writeConfig({ ...GITHUB, trusted: ['bob'], sources: GOING });
			expect(await start()).toBe(0);
			expect(out.join('\n')).toContain('gives the Go for bob');
		});
	});

	it('does not stop a build, which never reads a Source', async () => {
		withSources();
		const checked = await checkMachine({
			useApiKey: false,
			env: m.env,
			cwd: m.root,
			failFast: true,
			gh: github.gh
		});
		expect(checked.ready).not.toBeNull();
		expect(checked.lines.find((l) => l.source === 'sentry')?.status).toBe('fail');
	});
});

describe('nightjar doctor over Workflows', () => {
	const step = (name: string, prompt: string) => ({ name, prompt, point: 'afterAllTickets' });
	const WORKFLOWS = {
		'design-review': { steps: [step('critique', '/design-critic critique the screens')] },
		quick: { steps: [step('tidy', 'tidy up the code, see /tmp/notes')] }
	};

	function withWorkflows(skills: string) {
		m = machine();
		m.writeConfig({ ...GITHUB, workflows: WORKFLOWS });
		return { ...m.env, FAKE_CLAUDE_SKILLS: skills };
	}

	it('finds the skill a Step names among those a headless session loads', async () => {
		const env = withWorkflows('design-critic,tdd');
		expect(await start({ env })).toBe(0);
		expect(out).toContain('  ok    Workflow design-review: 1 Step, skills found: /design-critic');
		expect(out.join('\n')).toContain('Workflow quick:');
	});

	it('finds a skill under its plugin prefix', async () => {
		const env = withWorkflows('design-critic:design-critic');
		const code = await start({ env });
		expect(err).toEqual([]);
		expect(code).toBe(0);
	});

	it('lists the skills of a session started with the plugins of factory.json', async () => {
		m = machine();
		m.writeConfig({ ...GITHUB, plugins: ['.claude'], workflows: WORKFLOWS });
		const asked: string[][] = [];
		const skills = (_cwd: string, _env: unknown, plugins: readonly string[]) => {
			asked.push([...plugins]);
			return Promise.resolve(['design-critic']);
		};
		const checked = await checkMachine({
			useApiKey: false,
			env: m.env,
			cwd: m.root,
			failFast: true,
			gh: github.gh,
			skills
		});
		expect(asked).toEqual([[join(m.root, '.claude')]]);
		expect(checked.ready?.workflowProblems).toEqual({});
	});

	it('tells a missing skill to be named in plugins of factory.json', async () => {
		const env = withWorkflows('tdd');
		await start({ env });
		expect(err.join('\n')).toContain('"plugins"');
	});

	it('fails the Workflow that names a missing skill, and no other', async () => {
		const env = withWorkflows('tdd');
		expect(await start({ env })).toBe(2);
		expect(err.join('\n')).toMatch(
			/FAIL {2}Workflow design-review: step critique names \/design-critic, which a headless claude session does not load/
		);
		expect(err.join('\n')).not.toContain('Workflow quick');
		expect(out.join('\n')).toContain('  ok    Workflow quick:');
		// the rest of doctor still ran
		expect(out).toContain('  ok    factory.json: read');
	});

	it('does not stop a build: only a Feature that picks the broken Workflow is refused', async () => {
		const env = withWorkflows('tdd');
		const checked = await checkMachine({
			useApiKey: false,
			env,
			cwd: m.root,
			failFast: true,
			gh: github.gh
		});
		expect(checked.ready?.workflowProblems).toEqual({
			'design-review': expect.stringContaining('/design-critic') as string
		});
		expect(
			checked.lines.filter((l) => l.status === 'fail').every((l) => l.only !== undefined)
		).toBe(true);
	});

	it('does not start a claude session when no Step names a skill', async () => {
		m = machine();
		m.writeConfig({ ...GITHUB, workflows: { quick: WORKFLOWS.quick } });
		expect(await start()).toBe(0);
		// a path such as /tmp/notes is no skill
		expect(m.calls('claude')).not.toMatch(/^-p /m);
	});
});
