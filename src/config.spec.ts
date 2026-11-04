import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, configJsonSchema, loadConfig, loadRules } from './config.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'nightjar-config-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const VALID = {
	$schema: './node_modules/@nonameolsson/nightjar/schema/factory.schema.json',
	tracker: { type: 'github' },
	codeHost: { type: 'github', repo: 'o/r' },
	check: 'make check',
	allowedCommands: ['make test', 'make lint *']
};

const write = (value: unknown) =>
	writeFileSync(join(root, 'factory.json'), JSON.stringify(value, null, '\t'));

const without = (key: keyof typeof VALID) =>
	Object.fromEntries(Object.entries(VALID).filter(([k]) => k !== key));

const loadValid = () => {
	write(VALID);
	return loadConfig(root);
};

const refusal = (): string => {
	try {
		loadConfig(root);
	} catch (fault) {
		if (fault instanceof ConfigError) return fault.message;
		throw fault;
	}
	throw new Error('the config loaded');
};

describe('loadConfig', () => {
	it('reads the plugin directories of plugins', () => {
		write({ ...VALID, plugins: ['.claude'] });
		expect(loadConfig(root).plugins).toEqual(['.claude']);
	});

	it('refuses a plugin directory outside the repo', () => {
		for (const bad of ['/etc/plugin', '../plugin', 'a/../../plugin']) {
			write({ ...VALID, plugins: [bad] });
			expect(refusal()).toContain('plugins');
		}
	});

	it('loads a valid factory.json', () => {
		write(VALID);
		expect(loadConfig(root)).toEqual({
			tracker: { type: 'github' },
			codeHost: { type: 'github', repo: 'o/r' },
			check: 'make check',
			allowedCommands: ['make test', 'make lint *'],
			signals: DEFAULT_SIGNAL_NAMES
		});
	});

	it('loads the prompt, model and review settings, and leaves them out when not set', () => {
		write({
			...VALID,
			rules: 'docs/rules.md',
			model: 'sonnet',
			effort: 'high',
			review: { enabled: false, model: 'opus', effort: 'medium' }
		});
		expect(loadConfig(root)).toMatchObject({
			rules: 'docs/rules.md',
			model: 'sonnet',
			effort: 'high',
			review: { enabled: false, model: 'opus', effort: 'medium' }
		});
		write(VALID);
		expect(loadConfig(root)).not.toHaveProperty('review');
	});

	it('refuses a review setting that is not one it knows', () => {
		write({ ...VALID, review: { enabled: 'no' } });
		expect(refusal()).toMatch(/^factory\.json: review\.enabled: /m);
		write({ ...VALID, review: { model: 'opus', off: true } });
		expect(refusal()).toMatch(/off/);
	});

	it('loads the Pull-check pass, and leaves it out, so off, when not set', () => {
		write({ ...VALID, pullChecks: { enabled: true } });
		expect(loadConfig(root)).toMatchObject({ pullChecks: { enabled: true } });
		write(VALID);
		expect(loadConfig(root)).not.toHaveProperty('pullChecks');
	});

	it("loads the Pull-check pass's round, dollar and minute limits", () => {
		write({ ...VALID, pullChecks: { enabled: true, fixRounds: 3, fixUsd: 2.5, fixMinutes: 20 } });
		expect(loadConfig(root)).toMatchObject({
			pullChecks: { enabled: true, fixRounds: 3, fixUsd: 2.5, fixMinutes: 20 }
		});
	});

	it('refuses Pull-check limits out of range', () => {
		write({ ...VALID, pullChecks: { fixRounds: 0 } });
		expect(refusal()).toMatch(/^factory\.json: pullChecks\.fixRounds: /m);
		write({ ...VALID, pullChecks: { fixRounds: 1.5 } });
		expect(refusal()).toMatch(/^factory\.json: pullChecks\.fixRounds: /m);
		write({ ...VALID, pullChecks: { fixUsd: 0 } });
		expect(refusal()).toMatch(/^factory\.json: pullChecks\.fixUsd: /m);
		write({ ...VALID, pullChecks: { fixMinutes: -5 } });
		expect(refusal()).toMatch(/^factory\.json: pullChecks\.fixMinutes: /m);
	});

	it('refuses a Pull-check setting that is not one it knows', () => {
		write({ ...VALID, pullChecks: { enabled: 'yes' } });
		expect(refusal()).toMatch(/^factory\.json: pullChecks\.enabled: /m);
		write({ ...VALID, pullChecks: { enabled: true, rerun: true } });
		expect(refusal()).toMatch(/rerun/);
	});

	it('loads a Tracker and a Code host named as a module path, with their options', () => {
		const modules = {
			tracker: { type: 'module', path: './adapters/tracker.js', options: { project: 'x' } },
			codeHost: { type: 'module', path: './adapters/host.js' }
		};
		write({ ...VALID, ...modules });
		expect(loadConfig(root)).toMatchObject(modules);
	});

	it.each([
		['no path', { type: 'module' }, 'tracker.path'],
		['an empty path', { type: 'module', path: ' ' }, 'tracker.path'],
		['a field it does not know', { type: 'module', path: './t.js', repo: 'o/r' }, 'tracker']
	])('refuses a module Tracker with %s, naming the field', (_what, tracker, field) => {
		write({ ...VALID, tracker });
		expect(refusal()).toContain(`factory.json: ${field}`);
	});

	it('refuses a file with no check command, and never supplies one', () => {
		write(without('check'));
		expect(refusal()).toMatch(/^factory\.json: check: missing/m);
	});

	it('refuses an empty check command', () => {
		write({ ...VALID, check: '  ' });
		expect(refusal()).toMatch(/^factory\.json: check: /m);
	});

	it('refuses a file with no allowed commands', () => {
		write(without('allowedCommands'));
		expect(refusal()).toMatch(/^factory\.json: allowedCommands: /m);
	});

	it('loads a setup command and reserved ports, and sets neither by itself', () => {
		write(VALID);
		expect(loadConfig(root)).not.toHaveProperty('setup');
		expect(loadConfig(root)).not.toHaveProperty('ports');
		const asked = { setup: 'make deps', ports: { count: 5, env: ['WEB_PORT', 'DB_PORT'] } };
		write({ ...VALID, ...asked });
		expect(loadConfig(root)).toMatchObject(asked);
	});

	it('loads a gate, and sets none by itself', () => {
		write(VALID);
		expect(loadConfig(root)).not.toHaveProperty('gate');
		const asked = {
			failingTest: '^not ok \\d+ - (.+)$',
			ignore: '^budget: ',
			stages: { red: '^(\\S+)\\s+red\\b', log: '.cache/{stage}.log' }
		};
		write({ ...VALID, gate: asked });
		expect(loadConfig(root)).toMatchObject({ gate: asked });
	});

	it.each([
		['a pattern that is no regular expression', { failingTest: '(' }, 'gate.failingTest'],
		['a failingTest with no group for the name', { failingTest: '^FAIL' }, 'gate.failingTest'],
		['an ignore that is no regular expression', { ignore: '[' }, 'gate.ignore'],
		['a stage pattern with no group', { stages: { red: 'red' } }, 'gate.stages.red'],
		[
			'a stage log with no {stage}',
			{ stages: { red: '^(\\S+) red', log: 'all.log' } },
			'gate.stages.log'
		],
		[
			'a stage log outside the worktree',
			{ stages: { red: '^(\\S+) red', log: '../{stage}.log' } },
			'gate.stages.log'
		],
		[
			'an absolute stage log',
			{ stages: { red: '^(\\S+) red', log: '/tmp/{stage}.log' } },
			'gate.stages.log'
		]
	])('refuses %s', (_, gate, field) => {
		write({ ...VALID, gate });
		expect(refusal()).toContain(`factory.json: ${field}`);
	});

	it('refuses an empty setup command', () => {
		write({ ...VALID, setup: ' ' });
		expect(refusal()).toMatch(/^factory\.json: setup: /m);
	});

	it.each([
		['no ports', { count: 0, env: ['WEB_PORT'] }, 'ports.count'],
		['no variable names', { count: 2, env: [] }, 'ports.env'],
		['more names than ports', { count: 1, env: ['A_PORT', 'B_PORT'] }, 'ports.env'],
		['a name twice', { count: 2, env: ['A_PORT', 'A_PORT'] }, 'ports.env'],
		['a name that is no variable', { count: 2, env: ['A PORT'] }, 'ports.env.0'],
		['no variable names at all', { count: 2 }, 'ports.env']
	])('refuses reserved ports with %s, naming the field', (_what, ports, field) => {
		write({ ...VALID, ports });
		expect(refusal()).toContain(`factory.json: ${field}: `);
	});

	it('refuses a tracker it does not know, naming the field', () => {
		write({ ...VALID, tracker: { type: 'paper' } });
		expect(refusal()).toMatch(/^factory\.json: tracker\.type: /m);
	});

	it('loads Azure DevOps Boards as the Tracker, with its organization, project and Feature type', () => {
		const tracker = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam Fiber',
			featureType: 'Product Backlog Item'
		};
		write({ ...VALID, tracker });
		expect(loadConfig(root).tracker).toEqual(tracker);
	});

	it.each([
		['organization', 'tracker.organization'],
		['project', 'tracker.project'],
		['featureType', 'tracker.featureType']
	])('refuses an Azure DevOps Tracker with no %s, naming the field', (key, field) => {
		const whole = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam',
			featureType: 'Feature'
		};
		const tracker = Object.fromEntries(Object.entries(whole).filter(([k]) => k !== key));
		write({ ...VALID, tracker });
		expect(refusal()).toMatch(new RegExp(`^factory\\.json: ${field}: missing: `, 'm'));
	});

	it('loads the work item type a Ticket is made as, for nightjar create', () => {
		const tracker = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam',
			featureType: 'Feature',
			ticketType: 'User Story'
		};
		write({ ...VALID, tracker });
		expect(loadConfig(root).tracker).toEqual(tracker);
		write({ ...VALID, tracker: { ...tracker, ticketType: ' ' } });
		expect(refusal()).toMatch(/^factory\.json: tracker\.ticketType: /m);
	});

	it('refuses an Azure DevOps organization given as an address, not a name', () => {
		const tracker = {
			type: 'azure-devops',
			organization: 'https://dev.azure.com/contoso',
			project: 'Fabrikam',
			featureType: 'Feature'
		};
		write({ ...VALID, tracker });
		expect(refusal()).toMatch(/^factory\.json: tracker\.organization: /m);
	});

	it('loads Azure Repos as the Code host, with its organization, project and repo', () => {
		const codeHost = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam Fiber',
			repo: 'Fiber App'
		};
		write({ ...VALID, codeHost });
		expect(loadConfig(root).codeHost).toEqual(codeHost);
	});

	it.each([
		['organization', 'codeHost.organization'],
		['project', 'codeHost.project'],
		['repo', 'codeHost.repo']
	])('refuses an Azure Repos Code host with no %s, naming the field', (key, field) => {
		const whole = {
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam',
			repo: 'app'
		};
		const codeHost = Object.fromEntries(Object.entries(whole).filter(([k]) => k !== key));
		write({ ...VALID, codeHost });
		expect(refusal()).toMatch(new RegExp(`^factory\\.json: ${field}: missing: `, 'm'));
	});

	it('refuses an Azure Repos organization given as an address, not a name', () => {
		const codeHost = {
			type: 'azure-devops',
			organization: 'dev.azure.com/contoso',
			project: 'Fabrikam',
			repo: 'app'
		};
		write({ ...VALID, codeHost });
		expect(refusal()).toMatch(/^factory\.json: codeHost\.organization: /m);
	});

	it('refuses a code host repo that is not owner/name', () => {
		write({ ...VALID, codeHost: { type: 'github', repo: 'just-a-name' } });
		expect(refusal()).toMatch(/^factory\.json: codeHost\.repo: /m);
	});

	it('refuses a field it does not know, so a typo is never ignored', () => {
		write({ ...VALID, checks: 'make check' });
		expect(refusal()).toMatch(/checks/);
	});

	it('says so when there is no factory.json, or it is not JSON', () => {
		expect(refusal()).toMatch(/no factory\.json/);
		writeFileSync(join(root, 'factory.json'), '{"check":');
		expect(refusal()).toMatch(/factory\.json is not JSON/);
	});
});

describe('loadRules', () => {
	it('is null without a rules file, else the text of the file named, from the repo root', () => {
		const config = { ...loadValid(), rules: 'rules.md' };
		expect(loadRules(root, loadValid())).toBeNull();
		writeFileSync(join(root, 'rules.md'), 'Write small functions.\n');
		expect(loadRules(root, config)).toBe('## rules.md\n\nWrite small functions.');
	});

	it('carries the CLAUDE.md and AGENTS.md of the repo, which a restricted session does not load', () => {
		const config = { ...loadValid(), rules: 'rules.md' };
		writeFileSync(join(root, 'CLAUDE.md'), 'Use tabs.\n');
		expect(loadRules(root, loadValid())).toBe('## CLAUDE.md\n\nUse tabs.');
		writeFileSync(join(root, 'AGENTS.md'), 'Run make.\n');
		writeFileSync(join(root, 'rules.md'), 'Small functions.\n');
		expect(loadRules(root, config)).toBe(
			'## CLAUDE.md\n\nUse tabs.\n\n## AGENTS.md\n\nRun make.\n\n## rules.md\n\nSmall functions.'
		);
	});

	it('refuses a rules file that cannot be read, naming it', () => {
		const config = { ...loadValid(), rules: 'missing.md' };
		expect(() => loadRules(root, config)).toThrow(/factory\.json: rules: cannot read missing\.md/);
	});
});

describe('Signal names in factory.json', () => {
	it('defaults to the names that match the triage roles, with a Go of its own', () => {
		write(VALID);
		expect(loadConfig(root).signals).toEqual({
			go: 'factory-go',
			ready: 'ready-for-agent',
			working: 'agent-working',
			needsInfo: 'needs-info',
			human: 'ready-for-human'
		});
	});

	it('renames one Signal and leaves the rest at their defaults', () => {
		write({ ...VALID, signals: { working: 'bot-busy' } });
		expect(loadConfig(root).signals).toEqual({ ...DEFAULT_SIGNAL_NAMES, working: 'bot-busy' });
	});

	it('lets the Go share the name of ready, which gives the one-label behaviour', () => {
		write({ ...VALID, signals: { go: 'ready-for-agent' } });
		const { signals } = loadConfig(root);
		expect(signals.go).toBe('ready-for-agent');
		expect(signals.ready).toBe('ready-for-agent');
	});

	it.each(['needs-triage', 'wontfix'])('refuses %s, which Nightjar never reads or sets', (name) => {
		write({ ...VALID, signals: { human: name } });
		expect(refusal()).toMatch(/^factory\.json: signals\.human: .*never reads or sets/m);
	});

	it('refuses an empty name and a Signal it does not know', () => {
		write({ ...VALID, signals: { go: ' ' } });
		expect(refusal()).toMatch(/^factory\.json: signals\.go: /m);
		write({ ...VALID, signals: { stuck: 'stuck' } });
		expect(refusal()).toMatch(/stuck/);
	});
});

describe('the trusted list in factory.json', () => {
	it('is left out unless the repo writes one, so the Tracker adapter default holds', () => {
		write(VALID);
		expect(loadConfig(root).trusted).toBeUndefined();
	});

	it('loads the logins it names', () => {
		write({ ...VALID, trusted: ['ann', 'bob'] });
		expect(loadConfig(root).trusted).toEqual(['ann', 'bob']);
	});

	it('refuses an empty login', () => {
		write({ ...VALID, trusted: ['ann', ''] });
		expect(refusal()).toMatch(/^factory\.json: trusted\.1: /m);
	});
});

describe('sources', () => {
	const SOURCES = {
		sentry: {
			type: 'sentry',
			template: 'sentry',
			key: 'data.event.issue_id',
			secretEnv: 'SENTRY_HOOK_SECRET'
		},
		'weekly-deps': {
			type: 'schedule',
			cron: '0 6 * * 1',
			template: 'weekly-deps',
			go: true,
			owner: 'o'
		}
	};

	it('is left out unless the repo writes it', () => {
		write(VALID);
		expect(loadConfig(root).sources).toBeUndefined();
	});

	// factory.json with one Source named a
	const one = (source: Record<string, unknown>) => write({ ...VALID, sources: { a: source } });

	it('loads each Source with its fields as written', () => {
		const quick = { type: 'schedule', cron: '@daily', template: 'a.md', maxPerDay: 1 };
		write({ ...VALID, sources: { ...SOURCES, quick } });
		expect(loadConfig(root).sources).toEqual({ ...SOURCES, quick });
	});

	it('refuses a Source without a template, naming the Source', () => {
		write({ ...VALID, sources: { sentry: { type: 'sentry', secretEnv: 'X' } } });
		expect(refusal()).toMatch(
			/^factory\.json: sources\.sentry\.template: missing: name the template/m
		);
		write({ ...VALID, sources: { sentry: { type: 'sentry', template: ' ', secretEnv: 'X' } } });
		expect(refusal()).toMatch(/^factory\.json: sources\.sentry\.template: /m);
	});

	it('refuses a Source with go: true and no owner, naming the Source', () => {
		const noOwner = { type: 'schedule', cron: '@weekly', template: 'weekly-deps', go: true };
		write({ ...VALID, sources: { 'weekly-deps': noOwner } });
		expect(refusal()).toMatch(/^factory\.json: sources\.weekly-deps\.owner: missing: .*owner/m);
	});

	it('lets a Source have an owner and no go, or go: false and no owner', () => {
		const schedule = { type: 'schedule', cron: '@weekly', template: 't' };
		write({
			...VALID,
			sources: { a: { ...schedule, owner: 'o' }, b: { ...schedule, go: false } }
		});
		expect(Object.keys(loadConfig(root).sources ?? {})).toEqual(['a', 'b']);
	});

	it('refuses a type it does not know, and a Source without one', () => {
		one({ type: 'slack', template: 't' });
		expect(refusal()).toMatch(/^factory\.json: sources\.a\.type: /m);
		one({ template: 't' });
		expect(refusal()).toMatch(/^factory\.json: sources\.a\.type: missing: name the type/m);
	});

	it('wants a cron time on a schedule, and on nothing else', () => {
		one({ type: 'schedule', template: 't' });
		expect(refusal()).toMatch(/^factory\.json: sources\.a\.cron: missing: /m);
		one({ type: 'webhook', template: 't', cron: '@daily' });
		expect(refusal()).toMatch(/^factory\.json: sources\.a\.cron: only a schedule/m);
	});

	it('takes a cron time of five fields, @daily or @weekly', () => {
		for (const cron of ['@daily', '@weekly', '0 6 * * 1', '*/15 8-18 1,15 * 1-5']) {
			one({ type: 'schedule', template: 't', cron });
			expect(loadConfig(root).sources?.a?.cron).toBe(cron);
		}
	});

	it('refuses any other cron time', () => {
		for (const cron of ['', 'soon', '0 6 * *', '0 6 * * * *', '@hourly']) {
			one({ type: 'schedule', template: 't', cron });
			expect(refusal()).toMatch(/^factory\.json: sources\.a\.cron: /m);
		}
	});

	it('refuses a cron time that has the shape and is out of range, naming the Source', () => {
		const refused: Record<string, RegExp> = {
			'61 * * * *': /minute: 61 is not from 0 to 59/,
			'0 24 * * *': /hour: 24 is not from 0 to 23/,
			'0 0 0 * *': /day of month: 0 is not from 1 to 31/,
			'0 0 * 13 *': /month: 13 is not from 1 to 12/,
			'0 0 * * 8': /day of week: 8 is not from 0 to 7/,
			'30-10 * * * *': /minute: 30-10 runs backwards/,
			'*/0 * * * *': /minute: the step in "\*\/0" is not a number from 1/,
			'0 0 31 2 *': /never comes due/
		};
		for (const [cron, why] of Object.entries(refused)) {
			write({ ...VALID, sources: { 'weekly-deps': { type: 'schedule', template: 't', cron } } });
			expect(refusal()).toMatch(/^factory\.json: sources\.weekly-deps\.cron: /m);
			expect(refusal()).toMatch(why);
		}
	});

	it('refuses a field it does not know, such as a secret in factory.json', () => {
		one({ type: 'webhook', template: 't', secret: 'hunter2' });
		expect(refusal()).toMatch(/sources\.a: Unrecognized key.*secret/m);
	});

	it('refuses a secretEnv that is no variable name, and a maxPerDay under 1', () => {
		one({ type: 'webhook', template: 't', secretEnv: 'my secret' });
		expect(refusal()).toMatch(/^factory\.json: sources\.a\.secretEnv: /m);
		one({ type: 'webhook', template: 't', maxPerDay: 0 });
		expect(refusal()).toMatch(/^factory\.json: sources\.a\.maxPerDay: /m);
	});

	it('refuses a Source name with a space, which the marker could not carry', () => {
		write({ ...VALID, sources: { 'a b': { type: 'webhook', template: 't' } } });
		expect(refusal()).toMatch(/^factory\.json: sources\.a b: /m);
	});
});

describe('the published JSON Schema', () => {
	it('is the schema factory.json is validated with (run npm run schema when this fails)', () => {
		const committed: unknown = JSON.parse(
			readFileSync(new URL('../schema/factory.schema.json', import.meta.url), 'utf8')
		);
		expect(committed).toEqual(configJsonSchema());
	});
});

describe('workflows', () => {
	const step = { name: 'critique', prompt: '/some-skill critique', point: 'afterAllTickets' };
	const WORKFLOWS = { 'design-review': { steps: [step] } };

	it('loads named Workflows with their Steps, and a default', () => {
		write({
			...VALID,
			ports: { count: 2, env: ['WEB_PORT'] },
			workflows: {
				'design-review': {
					steps: [
						step,
						{
							name: 'polish',
							prompt: '/some-skill polish',
							point: 'afterEachTicket',
							model: 'opus',
							effort: 'high',
							budgetUsd: 5,
							until: 'nothing is left to polish',
							maxRounds: 4
						}
					],
					serve: 'npm run dev',
					allowedCommands: ['npm run e2e'],
					allowedTools: ['mcp__browser__*'],
					localNetwork: true
				}
			},
			defaultWorkflow: 'design-review'
		});
		const config = loadConfig(root);
		expect(config.defaultWorkflow).toBe('design-review');
		expect(config.workflows?.['design-review']?.steps.map((s) => s.name)).toEqual([
			'critique',
			'polish'
		]);
		expect(config.workflows?.['design-review']?.steps[1]).toMatchObject({ maxRounds: 4 });
	});

	it('has none by default, so a build adds nothing', () => {
		const config = loadValid();
		expect(config.workflows).toBeUndefined();
		expect(config.defaultWorkflow).toBeUndefined();
	});

	it.each([
		[{ steps: [] }, 'steps: a Workflow needs at least one Step'],
		[{ steps: [{ ...step, point: 'sometimes' }] }, 'point'],
		[{ steps: [{ ...step, prompt: ' ' }] }, 'give the Step a prompt'],
		[{ steps: [{ ...step, maxRounds: 3 }] }, 'maxRounds needs an until'],
		[{ steps: [step, step] }, 'a Step name is used twice'],
		[{ steps: [step], serve: 'npm run dev' }, 'a Workflow with serve needs ports'],
		[{ steps: [{ ...step, extra: 1 }] }, 'extra']
	])('refuses the Workflow %j', (workflow, said) => {
		write({ ...VALID, workflows: { w: workflow } });
		expect(refusal()).toContain(said);
	});

	it('loads a Workflow with a prompt and no Steps, and one with both', () => {
		write({
			...VALID,
			workflows: {
				bug: { prompt: 'Write a failing test first.' },
				both: { prompt: 'p', steps: [step] }
			}
		});
		const { workflows } = loadConfig(root);
		expect(workflows?.bug).toEqual({ prompt: 'Write a failing test first.', steps: [] });
		expect(workflows?.both?.prompt).toBe('p');
		expect(workflows?.both?.steps).toHaveLength(1);
	});

	it('leaves the prompt out of a Workflow that names none', () => {
		write({ ...VALID, workflows: WORKFLOWS });
		expect(loadConfig(root).workflows?.['design-review']).not.toHaveProperty('prompt');
	});

	it('refuses an empty prompt, and a Workflow with neither Steps nor a prompt', () => {
		write({ ...VALID, workflows: { w: { prompt: ' ', steps: [step] } } });
		expect(refusal()).toContain('prompt: prompt is empty');
		write({ ...VALID, workflows: { w: {} } });
		expect(refusal()).toContain('a Workflow needs at least one Step or a prompt');
	});

	it('accepts the bug Workflow Nightjar ships, as a repo copies it into workflows', () => {
		const bug: unknown = JSON.parse(
			readFileSync(new URL('../templates/workflows/bug.json', import.meta.url), 'utf8')
		);
		write({ ...VALID, workflows: { bug } });
		const prompt = loadConfig(root).workflows?.bug?.prompt ?? '';
		expect(prompt).toMatch(/test that shows the problem/);
		expect(prompt).toMatch(/see it fail/);
		expect(prompt).toMatch(/Fix the code/);
		expect(prompt).toMatch(/see it pass/);
		expect(prompt).toMatch(/Keep the test/);
		expect(prompt).toMatch(/final answer/);
	});

	it('refuses a default that names no Workflow', () => {
		write({ ...VALID, workflows: WORKFLOWS, defaultWorkflow: 'nope' });
		expect(refusal()).toContain('defaultWorkflow: names no Workflow of workflows');
		write({ ...VALID, defaultWorkflow: 'design-review' });
		expect(refusal()).toContain('defaultWorkflow: names no Workflow of workflows');
	});
});
