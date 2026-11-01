// `nightjar doctor` by its output, over a machine of stand-ins for gh, az and claude.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machine, type Machine, type Tool } from './fakes/machine.js';
import { checkMachine } from './checks.js';
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
	return start(over);
}

function start(over: { env?: Record<string, string>; argv?: string[] } = {}) {
	return runNightjar(over.argv ?? ['doctor'], {
		platform: 'linux',
		cwd: m.root,
		env: { ...m.env, ...over.env }
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
				'  ok    claude: 2.1.314 (Claude Code), signed in',
				'  ok    git signing: commits unsigned',
				'nightjar: would build #1 One escape'
			])
		);
		expect(m.calls('gh')).not.toMatch(/-X (POST|PATCH|DELETE)/);
	});

	it('is what --dry-run does', async () => {
		expect(await doctor({ argv: ['--dry-run'] })).toBe(0);
		expect(out).toContain('nightjar: would build #1 One escape');
	});

	it('runs every check when gh and claude are both signed out, and says how to fix each', async () => {
		const code = await doctor({
			env: { FAKE_GH_SIGNED_OUT: '1', FAKE_CLAUDE_SIGNED_OUT: '1' }
		});
		expect(code).toBe(2);
		const said = err.join('\n');
		expect(said).toMatch(/FAIL {2}Tracker: .*run `gh auth login`/);
		expect(said).toMatch(/FAIL {2}Code host: .*run `gh auth login`/);
		expect(said).toMatch(/FAIL {2}claude: .*run `claude auth login`/);
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

	it('refuses a repo with no check command, reaching no Tracker', async () => {
		m = machine();
		const { check: _check, ...without } = GITHUB;
		m.writeConfig(without);
		expect(await start()).toBe(2);
		expect(err.join('\n')).toContain(
			'FAIL  factory.json: check: missing: name the command that checks the work'
		);
		expect(out.join('\n')).toContain('  skip  Tracker: needs a usable factory.json');
		expect(m.calls('gh')).toBe('');
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
		const checked = await checkMachine({ useApiKey: false, env, cwd: m.root, failFast: true });
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
