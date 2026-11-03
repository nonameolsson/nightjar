// `nightjar init` over a machine of stand-ins and scripted answers, so it needs no terminal.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAzureDevOps } from './azure-devops/fake-azure-devops.js';
import { loadConfig } from './config.js';
import { machine, type Machine } from './fakes/machine.js';
import { runNightjar } from './main.js';

let out: string[];
let err: string[];
let m: Machine;
let asked: string[];
// what the person sees: the lines said and the questions asked, in order
let transcript: string[];
beforeEach(() => {
	out = [];
	err = [];
	asked = [];
	transcript = [];
	m = machine();
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		out.push(a.join(' '));
		transcript.push(a.join(' '));
	});
	vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});
afterEach(() => {
	vi.restoreAllMocks();
	m.remove();
});

// The answers in order; once they run out the input has ended.
function init(answers: string[], env: Record<string, string> = {}, argv: string[] = ['init']) {
	const left = [...answers];
	const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
	ado.repository('fabrikam-app');
	return runNightjar(argv, {
		platform: 'linux',
		cwd: m.root,
		env: { ...m.env, ...env },
		request: ado.request,
		ask: (question) => {
			asked.push(question);
			const next = left.shift() ?? null;
			transcript.push(`${question}${next ?? '<end of input>'}`);
			return Promise.resolve(next);
		}
	});
}

const written = () => join(m.root, 'factory.json');

describe('nightjar init on GitHub', () => {
	it('writes a factory.json that passes the schema, from the answers', async () => {
		expect(
			await init(['github', '', 'github', '', 'make check', 'make check, make test', ''])
		).toBe(0);
		expect(m.readConfig()).toEqual({
			$schema: 'https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json',
			tracker: { type: 'github' },
			codeHost: { type: 'github' },
			check: 'make check',
			allowedCommands: ['make check', 'make test']
		});
		expect(loadConfig(m.root).check).toBe('make check');
		expect(err).toEqual([]);
	});

	it('offers the repo origin names, and writes a repo only when it is another', async () => {
		await init(['github', 'acme/widgets', 'github', '', 'make check', '', '']);
		expect(asked[1]).toContain('[o/r]');
		expect(m.readConfig()).toMatchObject({
			tracker: { type: 'github', repo: 'acme/widgets' },
			codeHost: { type: 'github' }
		});
	});

	it('creates the Signal labels and says so', async () => {
		await init(['github', '', 'github', '', 'make check', '', '']);
		for (const name of [
			'factory-go',
			'ready-for-agent',
			'agent-working',
			'needs-info',
			'ready-for-human'
		]) {
			expect(m.calls('gh')).toContain(`-X POST repos/o/r/labels -f name=${name} `);
			expect(out).toContain(`nightjar: created the label ${name}`);
		}
	});

	it('leaves a label that exists, and says so', async () => {
		await init(['github', '', 'github', '', 'make check', '', ''], {
			FAKE_GH_EXISTING: 'factory-go,needs-info'
		});
		expect(out).toContain('nightjar: the label factory-go exists already');
		expect(out).toContain('nightjar: created the label agent-working');
	});

	it('checks every login, listing what it found', async () => {
		await init(['github', '', 'github', '', 'make check', '', '']);
		expect(out).toContain('  ok    Tracker: gh as ann on o/r');
		expect(out).toContain(
			`  ok    claude: 2.1.314 (Claude Code), ann@x.io, Acme, max plan, claude.ai login, config ${m.env.HOME}/.claude`
		);
	});

	it('says how to fix a login that is missing, and creates no label with it', async () => {
		const code = await init(['github', '', 'github', '', 'make check', '', ''], {
			FAKE_GH_SIGNED_OUT: '1',
			FAKE_CLAUDE_SIGNED_OUT: '1'
		});
		expect(code).toBe(2);
		expect(err.join('\n')).toMatch(/FAIL {2}Tracker: .*run `gh auth login`/);
		expect(err.join('\n')).toMatch(
			/FAIL {2}claude: .*not signed in.*type \/login, or pass another --profile/
		);
		expect(out.join('\n')).toContain('Signal labels not created');
		expect(m.calls('gh')).not.toContain('POST');
		// the file is written all the same, and init can be run again
		expect(existsSync(written())).toBe(true);
	});

	it('says what to do when the labels cannot be created', async () => {
		const code = await init(['github', '', 'github', '', 'make check', '', ''], {
			FAKE_GH_NO_LABELS: '1'
		});
		expect(code).toBe(2);
		expect(err.join('\n')).toContain('FAIL  Signals: gh could not create the label factory-go');
	});
});

describe('nightjar init asks, never guesses', () => {
	it('asks for the check command with no default, and asks again when it is left empty', async () => {
		expect(await init(['github', '', 'github', '', '', '  ', 'make check', '', ''])).toBe(0);
		const check = asked.filter((q) => q.includes('checks the work'));
		expect(check).toHaveLength(3);
		expect(check.every((q) => !q.includes('['))).toBe(true);
		expect(out).toContain('  name the command that checks the work');
		expect(m.readConfig()).toMatchObject({ check: 'make check' });
	});

	it('warns about a check that can never fail, and reports that it passes on the clean tree', async () => {
		// the machine's PATH holds no sh, which the check runs through
		await init(['github', '', 'github', '', 'true', '', ''], { PATH: `${m.env.PATH ?? ''}:/bin` });
		expect(out.join('\n')).toContain('`true` can never fail');
		expect(out.join('\n')).toContain('the check passes');
	});

	it('warns about `:` and reports a check that fails right now', async () => {
		await init(['github', '', 'github', '', ':', '', '']);
		expect(out.join('\n')).toContain('`:` can never fail');
		out.length = 0;
		m.writeConfig({ ...loadConfig(m.root), check: 'false' });
		await init([]);
		expect(out.join('\n')).toContain('fails right now, so every Ticket will stop');
	});

	it('says so and suggests a placeholder when no check command is detected', async () => {
		await init(['github', '', 'github', '', 'make check', '', '']);
		expect(out.join('\n')).toContain('no check command detected');
		expect(out.join('\n')).toContain('`make check`');
	});

	it('offers make check from a Makefile, naming where it came from', async () => {
		writeFileSync(join(m.root, 'Makefile'), 'check:\n\techo ok\n');
		await init(['github', '', 'github', '', '', '', '']);
		expect(out.join('\n')).toContain('detected `make check` from Makefile "check"');
		expect(asked.find((q) => q.includes('checks the work'))).toContain('[make check]');
		expect(m.readConfig()).toMatchObject({ check: 'make check' });
	});

	it('reads package.json scripts and picks the package manager from the lockfile', async () => {
		writeFileSync(join(m.root, 'package.json'), '{"scripts":{"test":"vitest"}}');
		writeFileSync(join(m.root, 'pnpm-lock.yaml'), '');
		await init(['github', '', 'github', '', '', '', '']);
		expect(out.join('\n')).toContain('detected `pnpm test` from package.json "test"');
		expect(m.readConfig()).toMatchObject({ check: 'pnpm test' });
	});

	it('lists several matches numbered, and takes a number', async () => {
		writeFileSync(join(m.root, 'Makefile'), 'test:\n\techo ok\n');
		writeFileSync(join(m.root, 'go.mod'), 'module x\n');
		await init(['github', '', 'github', '', '2', '', '']);
		expect(out.join('\n')).toContain('1. make test  (from Makefile "test")');
		expect(out.join('\n')).toContain('2. go test ./...  (from go.mod)');
		expect(m.readConfig()).toMatchObject({ check: 'go test ./...' });
	});

	it('writes nothing when the input ends before the check command is given', async () => {
		expect(await init(['github', '', 'github', ''])).toBe(2);
		expect(err.join('\n')).toContain('the input ended before this was answered');
		expect(existsSync(written())).toBe(false);
	});

	it('asks again for a Tracker it does not know, and a repo that is not owner/name', async () => {
		await init(['svn', 'github', 'nope', 'acme/widgets', 'github', '', 'make check', '', '']);
		expect(out.join('\n')).toContain('  choose github, azure-devops or module');
		expect(out.join('\n')).toContain('  must be owner/name');
		expect(m.readConfig()).toMatchObject({ tracker: { repo: 'acme/widgets' } });
	});

	it('takes none for an empty list of commands the agent may run', async () => {
		await init(['github', '', 'github', '', 'make check', 'none', '']);
		expect(m.readConfig()).toMatchObject({ allowedCommands: [] });
	});

	it('offers detected test and lint commands besides the check command, and says what stays denied', async () => {
		writeFileSync(join(m.root, 'package.json'), '{"scripts":{"check":"x","test":"x","lint":"x"}}');
		await init(['github', '', 'github', '', '', '', '']);
		expect(asked.find((q) => q.includes('Commands the agent may run'))).toContain(
			'[npm run check, npm test, npm run lint]'
		);
		expect(m.readConfig()).toMatchObject({
			allowedCommands: ['npm run check', 'npm test', 'npm run lint']
		});
		expect(out.join('\n')).toContain('Examples: `make lint *`, `npm test`');
		expect(out.join('\n')).toContain('Commit, push, network and `gh` stay denied');
	});

	it('offers the check command as the command the agent may run', async () => {
		await init(['github', '', 'github', '', 'make check', '', '']);
		expect(m.readConfig()).toMatchObject({ allowedCommands: ['make check'] });
	});
});

describe('nightjar init on Azure DevOps', () => {
	const answers = [
		'azure-devops',
		'contoso',
		'Fabrikam',
		'',
		'User Story',
		'azure-devops',
		'',
		'',
		'fabrikam-app',
		'make check',
		'',
		''
	];

	it('asks for the organization, project and work item types and the repo, and takes the Tracker for the default', async () => {
		const code = await init(answers);
		expect(err).toEqual([]);
		expect(code).toBe(0);
		expect(m.readConfig()).toMatchObject({
			tracker: {
				type: 'azure-devops',
				organization: 'contoso',
				project: 'Fabrikam',
				featureType: 'Feature',
				ticketType: 'User Story'
			},
			codeHost: {
				type: 'azure-devops',
				organization: 'contoso',
				project: 'Fabrikam',
				repo: 'fabrikam-app'
			}
		});
	});

	it('says tags appear on first use, and creates no label', async () => {
		await init(answers);
		expect(out).toContain(
			'nightjar: Azure DevOps shows Signals as tags, which appear on first use: there is nothing to create.'
		);
		expect(m.calls('gh')).toBe('');
		expect(out).toContain(
			'  ok    Tracker: Azure DevOps as ann@contoso.com on contoso/Fabrikam, Azure Repos contoso/Fabrikam/fabrikam-app'
		);
	});

	it('leaves ticketType out when it is not given', async () => {
		await init(answers.map((a) => (a === 'User Story' ? '' : a)));
		expect(m.readConfig()).toMatchObject({ tracker: { featureType: 'Feature' } });
		expect(JSON.stringify(m.readConfig())).not.toContain('ticketType');
	});

	it('says to run az login when the Azure CLI is signed out', async () => {
		expect(await init(answers, { FAKE_AZ_SIGNED_OUT: '1' })).toBe(2);
		expect(err.join('\n')).toMatch(/FAIL {2}Tracker: .*az login/);
	});
});

describe('nightjar init with a module', () => {
	it('asks for the module path, and leaves the Signals to it', async () => {
		const methods = [
			'me',
			'assignedFeatures',
			'feature',
			'standing',
			'tickets',
			'comments',
			'addSignal',
			'removeSignal',
			'comment',
			'reference'
		];
		const body = methods
			.map((name) => (name === 'me' ? "me: async () => 'zed'" : `${name}: () => {}`))
			.join(', ');
		writeFileSync(join(m.root, 'tracker.mjs'), `export const createTracker = () => ({ ${body} });`);
		await init(['module', './tracker.mjs', 'github', '', 'make check', '', '']);
		expect(m.readConfig()).toMatchObject({ tracker: { type: 'module', path: './tracker.mjs' } });
		expect(out).toContain(
			'nightjar: ./tracker.mjs shows Signals its own way: Nightjar creates nothing for it.'
		);
	});
});

describe('nightjar init explains each prompt', () => {
	const promptsOnly = () => {
		const end = transcript.findIndex((line) => line.includes('this is what init will do'));
		return transcript.slice(0, end);
	};

	it('prints help before every prompt on GitHub, and shows longer help on ?', async () => {
		await init(['github', '', 'github', '', '?', 'make check', '?', '', '']);
		expect(promptsOnly().join('\n')).toMatchSnapshot();
	});

	it('prints help before every prompt on Azure DevOps', async () => {
		await init([
			'azure-devops',
			'contoso',
			'Fabrikam',
			'',
			'User Story',
			'azure-devops',
			'',
			'',
			'fabrikam-app',
			'make check',
			'',
			''
		]);
		expect(promptsOnly().join('\n')).toMatchSnapshot();
	});

	it('prints help before the module path prompt', async () => {
		writeFileSync(join(m.root, 'tracker.mjs'), 'export const createTracker = () => ({});');
		await init(['module', './tracker.mjs', 'github', '', 'make check', '', '']);
		expect(promptsOnly().join('\n')).toMatchSnapshot();
	});

	it('takes ? as a request for help, not as an answer', async () => {
		await init(['github', '', 'github', '', '?', 'make check', '', '']);
		expect(m.readConfig()).toMatchObject({ check: 'make check' });
		expect(out.join('\n')).toContain('No deploys and no network');
	});
});

describe('nightjar init shows what it will do, and asks before it writes', () => {
	const summary = () => {
		const start = transcript.findIndex((line) => line.includes('this is what init will do'));
		const end = transcript.findIndex((line) => line.startsWith('Write factory.json and go on'));
		return transcript.slice(start, end + 1).join('\n');
	};

	it('shows the factory.json, the Signal labels and the logins before it writes', async () => {
		await init(['github', 'acme/widgets', 'github', '', 'make check', '', '']);
		const shown = summary();
		expect(shown).toContain('  write factory.json:');
		expect(shown).toContain('    \t"check": "make check",');
		expect(shown).toContain('    \t\t"repo": "acme/widgets"');
		expect(shown).toContain(
			'  create the Signal labels on acme/widgets: factory-go, ready-for-agent, agent-working, needs-info, ready-for-human'
		);
		expect(shown).toContain('    GitHub CLI for the Tracker, on acme/widgets');
		expect(shown).toContain('    GitHub CLI for the Code host, on o/r');
		expect(shown).toContain('    claude, signed in to your Claude plan');
		expect(shown).toContain('  Any answer can be edited later in factory.json.');
		expect(asked).toContain('Write factory.json and go on, y or n [y]: ');
		expect(transcript.indexOf('nightjar: wrote factory.json')).toBeGreaterThan(
			transcript.findIndex((line) => line.startsWith('Write factory.json and go on'))
		);
	});

	it('says Azure DevOps needs no labels, and names the projects and the API key', async () => {
		await init(
			[
				'azure-devops',
				'contoso',
				'Fabrikam',
				'',
				'',
				'azure-devops',
				'',
				'',
				'fabrikam-app',
				'make check',
				'',
				'y'
			],
			{ ANTHROPIC_API_KEY: 'sk-x' },
			['init', '--use-api-key']
		);
		const shown = summary();
		expect(shown).toContain('create no Signal labels: Azure DevOps shows Signals as tags');
		expect(shown).toContain('    Azure CLI for the Tracker, on contoso/Fabrikam');
		expect(shown).toContain('    Azure CLI for the Code host, on contoso/Fabrikam/fabrikam-app');
		expect(shown).toContain('    claude, billing ANTHROPIC_API_KEY');
	});

	it('writes nothing, creates no label and checks no login on no', async () => {
		expect(await init(['github', '', 'github', '', 'make check', '', 'n'])).toBe(1);
		expect(existsSync(written())).toBe(false);
		expect(m.calls('gh')).not.toContain('POST');
		expect(out).toContain('nightjar: wrote nothing; run `nightjar init` again to start over');
		expect(out.join('\n')).not.toContain('Tracker: gh as');
	});

	it('asks again for an answer that is neither yes nor no', async () => {
		expect(await init(['github', '', 'github', '', 'make check', '', 'maybe', 'yes'])).toBe(0);
		expect(out).toContain('  answer y or n');
		expect(existsSync(written())).toBe(true);
	});

	it('writes nothing when the input ends at the confirmation', async () => {
		expect(await init(['github', '', 'github', '', 'make check', ''])).toBe(2);
		expect(existsSync(written())).toBe(false);
	});
});

describe('nightjar init ends with the next step', () => {
	const answers = ['github', '', 'github', '', 'make check', '', ''];

	it('says to run doctor, then to assign a Feature and give it the Go', async () => {
		expect(await init(answers)).toBe(0);
		expect(out).toEqual(
			expect.arrayContaining([
				'nightjar: ready. Commit factory.json, then:',
				'  1. run `nightjar doctor` to see what would build',
				'  2. assign a Feature to yourself and give it the Go'
			])
		);
	});

	it('offers to run doctor, and runs it on yes', async () => {
		expect(await init([...answers, ''])).toBe(0);
		expect(asked.at(-1)).toBe('Run `nightjar doctor` now, y or n [y]: ');
		expect(out).toContain('nightjar: would build #1 One escape');
	});

	it('runs no doctor on no', async () => {
		expect(await init([...answers, 'n'])).toBe(0);
		expect(out).not.toContain('nightjar: running `nightjar doctor`:');
		expect(out.join('\n')).not.toContain('would build #1');
	});

	it('asks again for an answer that is neither yes nor no', async () => {
		expect(await init([...answers, 'maybe', 'y'])).toBe(0);
		expect(out).toContain('  answer y or n');
		expect(out).toContain('nightjar: would build #1 One escape');
	});

	it('offers nothing under --yes, but still says the next step', async () => {
		expect(await init([], {}, ['init', '--yes', '--check', 'make check'])).toBe(0);
		expect(asked).toEqual([]);
		expect(out).toContain('  1. run `nightjar doctor` to see what would build');
	});
});

describe('nightjar init in a repo that has a factory.json', () => {
	const config = {
		tracker: { type: 'github' },
		codeHost: { type: 'github' },
		check: 'make check',
		allowedCommands: []
	};

	it('asks nothing and keeps the file, creating the labels and checking the logins', async () => {
		m.writeConfig(config);
		const before = readFileSync(written(), 'utf8');
		expect(await init([])).toBe(0);
		expect(asked).toEqual([]);
		expect(readFileSync(written(), 'utf8')).toBe(before);
		expect(m.calls('gh')).toContain('-X POST repos/o/r/labels -f name=factory-go ');
		expect(out).toContain('  ok    Tracker: gh as ann on o/r');
	});

	it('refuses a factory.json that is wrong, naming the field', async () => {
		m.writeConfig({ ...config, check: '' });
		expect(await init([])).toBe(2);
		expect(err.join('\n')).toContain('factory.json: check: name the command that checks the work');
	});
});

describe('nightjar init arguments', () => {
	it('takes only its own flags', async () => {
		expect(await init([], {}, ['init', 'now'])).toBe(2);
		expect(err.join('\n')).toContain('unknown argument now');
		expect(err.join('\n')).toContain('usage: nightjar init [--yes]');
	});

	it('refuses a value flag with no value', async () => {
		expect(await init([], {}, ['init', '--yes', '--check'])).toBe(2);
		expect(err.join('\n')).toContain('--check needs a value');
	});
});

describe('nightjar init with --yes and flags', () => {
	it('writes a valid factory.json from --yes and --check, asking nothing', async () => {
		expect(await init([], {}, ['init', '--yes', '--check', 'make check'])).toBe(0);
		expect(asked).toEqual([]);
		expect(m.readConfig()).toEqual({
			$schema: 'https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json',
			tracker: { type: 'github' },
			codeHost: { type: 'github' },
			check: 'make check',
			allowedCommands: ['make check']
		});
		expect(loadConfig(m.root).check).toBe('make check');
		expect(out).toContain('nightjar: wrote factory.json');
	});

	it('takes the detected check command under --yes', async () => {
		writeFileSync(join(m.root, 'Makefile'), 'test:\n\techo ok\n');
		writeFileSync(join(m.root, 'go.mod'), 'module x\n');
		expect(await init([], {}, ['init', '-y'])).toBe(0);
		expect(asked).toEqual([]);
		expect(out).toContain(
			'nightjar: detected several check commands; taking the first, `make test`'
		);
		expect(m.readConfig()).toMatchObject({ check: 'make test' });
	});

	it('refuses, naming the flag, when a required value has no default', async () => {
		expect(await init([], {}, ['init', '--yes'])).toBe(2);
		expect(err.join('\n')).toContain(
			'--yes found no default for: Command that checks the work, run after each Ticket; pass --check'
		);
		expect(existsSync(written())).toBe(false);
	});

	it('sets the Tracker and Code host from their flags', async () => {
		const code = await init([], {}, [
			'init',
			'--yes',
			'--check',
			'make check',
			'--tracker',
			'azure-devops',
			'--tracker-organization',
			'contoso',
			'--tracker-project',
			'Fabrikam',
			'--tracker-ticket-type',
			'User Story',
			'--code-host',
			'azure-devops',
			'--code-host-repo',
			'fabrikam-app',
			'--allowed-commands',
			'make check, make lint *'
		]);
		expect(err).toEqual([]);
		expect(code).toBe(0);
		expect(asked).toEqual([]);
		expect(m.readConfig()).toMatchObject({
			tracker: {
				type: 'azure-devops',
				organization: 'contoso',
				project: 'Fabrikam',
				featureType: 'Feature',
				ticketType: 'User Story'
			},
			codeHost: {
				type: 'azure-devops',
				organization: 'contoso',
				project: 'Fabrikam',
				repo: 'fabrikam-app'
			},
			allowedCommands: ['make check', 'make lint *']
		});
	});

	it('refuses the Azure Repos repo under --yes when no flag names it', async () => {
		const argv = ['init', '--yes', '--check', 'make check', '--tracker', 'azure-devops'];
		const where = ['--tracker-organization', 'contoso', '--tracker-project', 'F'];
		expect(await init([], {}, [...argv, ...where])).toBe(2);
		expect(err.join('\n')).toContain('pass --code-host-repo');
		expect(existsSync(written())).toBe(false);
	});

	it('refuses a flag whose value the schema does not take', async () => {
		const argv = ['init', '--yes', '--tracker-repo', 'nope', '--check', 'make check'];
		expect(await init([], {}, argv)).toBe(2);
		expect(err.join('\n')).toContain('--tracker-repo nope: must be owner/name');
		expect(existsSync(written())).toBe(false);
	});

	it('asks only what no flag answers, when --yes is not given', async () => {
		const argv = ['init', '--tracker', 'github', '--code-host', 'github', '--check', 'make check'];
		expect(await init(['', '', ''], {}, [...argv, '--tracker-repo', 'acme/widgets'])).toBe(0);
		expect(asked).toEqual([
			'GitHub repo the branch is pushed to, owner/name [o/r]: ',
			'Commands the agent may run, separated by commas, or none (? for more) [make check]: ',
			'Write factory.json and go on, y or n [y]: ',
			'Run `nightjar doctor` now, y or n [y]: '
		]);
		expect(m.readConfig()).toMatchObject({
			tracker: { repo: 'acme/widgets' },
			check: 'make check'
		});
	});
});
