// `nightjar init` over a machine of stand-ins and scripted answers, so it needs no terminal.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAzureDevOps, type FakeProcess } from './azure-devops/fake-azure-devops.js';
import { loadConfig } from './config.js';
import { oneEscape } from './fakes/github.js';
import { machine, type Machine } from './fakes/machine.js';
import { FakeGitHub } from './github/fake-github.js';
import { runNightjar } from './main.js';
import type { Prompter } from './prompter.js';
import { recap } from './recap.js';

let out: string[];
let err: string[];
let m: Machine;
let github: FakeGitHub;
let asked: string[];
// what the person sees: the lines said and the questions asked, in order
let transcript: string[];
beforeEach(() => {
	out = [];
	err = [];
	asked = [];
	transcript = [];
	m = machine();
	github = oneEscape();
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
function init(
	answers: string[],
	env: Record<string, string> = {},
	argv: string[] = ['init'],
	// a machine without gh has none to answer, so `realGh` leaves the fake GitHub out
	over: { kernel?: string; cwd?: string; realGh?: boolean } = {}
) {
	const left = [...answers];
	const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
	ado.repository('fabrikam-app');
	return runNightjar(argv, {
		os: { platform: 'linux', kernel: over.kernel ?? '' },
		cwd: over.cwd ?? m.root,
		env: { ...m.env, ...env },
		request: ado.request,
		...(over.realGh === true ? {} : { gh: github.gh }),
		ask: (question) => {
			asked.push(question);
			const next = left.shift() ?? null;
			transcript.push(`${question}${next ?? '<end of input>'}`);
			return Promise.resolve(next);
		}
	});
}

const written = () => join(m.root, 'factory.json');

// A module Tracker that has every method, and answers only who is signed in.
function writeTrackerModule() {
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
}

describe('nightjar init checks the machine before it writes', () => {
	const lacking = (without: Parameters<typeof machine>[0]) => {
		m.remove();
		m = machine(without);
	};
	const failed = () => err.filter((l) => l.startsWith('  FAIL  '));
	const expectNothingDone = () => {
		expect(asked).toEqual([]);
		expect(existsSync(written())).toBe(false);
		expect(existsSync(join(m.root, '.gitignore'))).toBe(false);
		expect(github.calls.filter((c) => c.method !== 'GET')).toEqual([]);
	};

	it.each([
		['with piped answers', ['init']],
		['under --yes', ['init', '--yes', '--check', 'make check']],
		['under --yes with a value missing', ['init', '--yes']]
	])('lists every failing check with its fix, and writes nothing, %s', async (_how, argv) => {
		lacking(['bwrap', 'socat']);
		github.signOut();
		const env = { ANTHROPIC_API_KEY: 'sk-test', FAKE_CLAUDE_SIGNED_OUT: '1' };
		expect(await init(['github', '', 'github', '', 'make check', '', ''], env, argv)).toBe(2);
		const said = failed().join('\n');
		expect(said).toMatch(/FAIL {2}API key: .*Unset it, or pass --use-api-key/);
		expect(said).toMatch(/FAIL {2}sandbox: bubblewrap and socat .*sudo apt-get install/);
		expect(said).toMatch(/FAIL {2}Tracker: .*run `gh auth login`/);
		expect(said).toMatch(/FAIL {2}Code host: .*run `gh auth login`/);
		expect(said).toMatch(/FAIL {2}claude: .*not signed in.*type \/login/);
		expect(failed()).toHaveLength(5);
		expect(err.at(-1)).toBe(
			'nightjar: 5 problems above, and nothing was written; fix it, then run `nightjar init` again.'
		);
		expectNothingDone();
	});

	it('puts no prompt on a terminal', async () => {
		lacking(['bwrap']);
		const prompted = () => Promise.reject(new Error('a prompt was shown'));
		const code = await runNightjar(['init'], {
			os: { platform: 'linux', kernel: '' },
			cwd: m.root,
			env: m.env,
			gh: github.gh,
			prompter: {
				text: prompted,
				select: prompted,
				multiselect: prompted,
				confirm: prompted,
				note: () => {
					throw new Error('a note was shown');
				}
			}
		});
		expect(code).toBe(2);
		expect(failed()).toHaveLength(1);
		expectNothingDone();
	});

	it('says where to get gh and claude when they are not installed', async () => {
		lacking(['gh', 'claude']);
		expect(await init([], {}, ['init'], { realGh: true })).toBe(2);
		const said = failed().join('\n');
		expect(said).toMatch(/FAIL {2}Tracker: gh is not on the PATH.*https:\/\/cli\.github\.com/);
		expect(said).toMatch(/FAIL {2}claude: claude is not on the PATH.*https:\/\/claude\.com/);
		expectNothingDone();
	});

	it('stops on WSL1, which cannot sandbox', async () => {
		expect(await init([], {}, ['init'], { kernel: '4.4.0-19041-Microsoft' })).toBe(2);
		expect(failed().join('\n')).toMatch(/FAIL {2}sandbox: .*move the distribution to WSL2/);
		expectNothingDone();
	});

	it('stops in a checkout with no origin, and says how to add one', async () => {
		spawnSync('git', ['remote', 'remove', 'origin'], { cwd: m.root, env: m.env });
		expect(await init([])).toBe(2);
		expect(failed().join('\n')).toMatch(/FAIL {2}git origin: .*git remote add origin/);
		expectNothingDone();
	});

	it('lists a missing checkout with whatever else is missing', async () => {
		const code = await init([], { FAKE_CLAUDE_SIGNED_OUT: '1' }, ['init'], { cwd: m.base });
		expect(code).toBe(2);
		const said = failed().join('\n');
		expect(said).toMatch(/FAIL {2}git checkout: not inside a git checkout; run Nightjar in/);
		expect(said).toMatch(/FAIL {2}claude: .*not signed in/);
		expectNothingDone();
	});

	it('says to install git when there is none', async () => {
		expect(await init([], { PATH: join(m.base, 'nothing') })).toBe(2);
		expect(failed().join('\n')).toMatch(/FAIL {2}git checkout: git is not on the PATH\. Install/);
		expectNothingDone();
	});

	it('checks the logins of the pair its flags name, under --yes', async () => {
		const argv = ['init', '--yes', '--check', 'make check', '--tracker', 'azure-devops'];
		const where = ['--tracker-organization', 'contoso', '--tracker-project', 'Fabrikam'];
		const repo = ['--code-host-repo', 'fabrikam-app'];
		const env = { FAKE_AZ_SIGNED_OUT: '1' };
		expect(await init([], env, [...argv, ...where, ...repo])).toBe(2);
		const said = failed().join('\n');
		expect(said).toMatch(/FAIL {2}Tracker: .*az login/);
		expect(said).toMatch(/FAIL {2}Code host: .*az login/);
		expectNothingDone();
	});

	it.each([
		['a new repo', false],
		['a repo that has a factory.json', true]
	])('reports what doctor reports on the same machine, in %s', async (_where, kept) => {
		lacking(['bwrap']);
		github.signOut();
		const env = { FAKE_CLAUDE_SIGNED_OUT: '1' };
		const config = {
			tracker: { type: 'github' },
			codeHost: { type: 'github' },
			check: 'make check',
			allowedCommands: []
		};
		if (kept) m.writeConfig(config);
		expect(await init([], env)).toBe(2);
		const fromInit = failed();
		expect(fromInit).toHaveLength(4);
		err.length = 0;
		m.writeConfig(config);
		expect(await init([], env, ['doctor'])).toBe(2);
		expect(failed()).toEqual(fromInit);
	});

	it('keeps a factory.json and creates no label when a check fails', async () => {
		m.writeConfig({
			tracker: { type: 'github' },
			codeHost: { type: 'github' },
			check: 'make check',
			allowedCommands: []
		});
		const before = readFileSync(written(), 'utf8');
		expect(await init([], { FAKE_CLAUDE_SIGNED_OUT: '1' })).toBe(2);
		expect(failed().join('\n')).toMatch(/FAIL {2}claude: .*not signed in/);
		expect(readFileSync(written(), 'utf8')).toBe(before);
		expect(github.repoLabelNames()).toEqual([]);
		expect(out.join('\n')).not.toContain('keeping it');
	});
});

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
			expect(github.repoLabelNames()).toContain(name);
			expect(out).toContain(`nightjar: created the label ${name}`);
		}
	});

	it('leaves a label that exists, and says so', async () => {
		github.addRepoLabel('factory-go');
		github.addRepoLabel('needs-info');
		await init(['github', '', 'github', '', 'make check', '', '']);
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

	it('says what to do when the labels cannot be created', async () => {
		github.refuseLabels();
		const code = await init(['github', '', 'github', '', 'make check', '', '']);
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

	// the machine's PATH holds no sh, which the check runs through
	const withSh = () => ({ PATH: `${m.env.PATH ?? ''}:/bin` });

	it('warns about a check that can never fail, and reports that it passes on this checkout', async () => {
		await init(['github', '', 'github', '', 'true', '', ''], withSh());
		expect(out.join('\n')).toContain('`true` can never fail');
		expect(out).toContain('nightjar: running the check once on this checkout: true');
		expect(out.join('\n')).toContain('the check passes');
	});

	it('warns about `:`', async () => {
		await init(['github', '', 'github', '', ':', '', ''], withSh());
		expect(out.join('\n')).toContain('`:` can never fail');
		expect(out.join('\n')).toContain('the check passes');
	});

	it('reports a check that fails right now', async () => {
		await init(['github', '', 'github', '', 'false', '', ''], withSh());
		expect(out.join('\n')).not.toContain('can never fail');
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

	it('refuses a list of numbers as the check command, and lists the choices indented', async () => {
		writeFileSync(join(m.root, 'Makefile'), 'test:\n\techo ok\n');
		writeFileSync(join(m.root, 'go.mod'), 'module x\n');
		await init(['github', '', 'github', '', '1,2', '2', '', '']);
		expect(out.join('\n')).toContain('pick one number');
		expect(out).toContain('  1. make test  (from Makefile "test")');
		expect(m.readConfig()).toMatchObject({ check: 'go test ./...' });
	});

	it('refuses a list of numbers as the check command when none is detected', async () => {
		await init(['github', '', 'github', '', '1,2', 'make check', '', '']);
		expect(out.join('\n')).toContain('the check is a single command');
		expect(m.readConfig()).toMatchObject({ check: 'make check' });
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
		expect(asked.find((q) => q.includes('Commands the Coding agent may run'))).toContain(
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
		// the gh login origin points to is read before the first question; nothing is made there
		expect(github.calls.filter((c) => c.method !== 'GET')).toEqual([]);
		expect(out).toContain(
			'  ok    Tracker: Azure DevOps as ann@contoso.com on contoso/Fabrikam, Azure Repos contoso/Fabrikam/fabrikam-app'
		);
	});

	it('leaves ticketType out when it is not given', async () => {
		await init(answers.map((a) => (a === 'User Story' ? '' : a)));
		expect(m.readConfig()).toMatchObject({ tracker: { featureType: 'Feature' } });
		expect(JSON.stringify(m.readConfig())).not.toContain('ticketType');
	});

	it('checks the logins of the pair the answers choose before it writes', async () => {
		expect(await init(answers, { FAKE_AZ_SIGNED_OUT: '1' })).toBe(2);
		expect(err.join('\n')).toMatch(/FAIL {2}Tracker: .*az login/);
		expect(err.at(-1)).toContain('nothing was written');
		expect(out.join('\n')).not.toContain('this is what init will do');
		expect(existsSync(written())).toBe(false);
	});
});

describe('nightjar init with a module', () => {
	it('asks for the module path, and leaves the Signals to it', async () => {
		writeTrackerModule();
		await init(['module', './tracker.mjs', 'github', '', 'make check', '', '']);
		expect(m.readConfig()).toMatchObject({ tracker: { type: 'module', path: './tracker.mjs' } });
		expect(out).toContain(
			'nightjar: ./tracker.mjs shows Signals its own way: Nightjar creates nothing for it.'
		);
	});
});

describe('nightjar init explains each prompt', () => {
	// the interview, then each later prompt with the line printed just before it
	const promptsOnly = () => {
		const end = transcript.findIndex((line) => line.includes('this is what init will do'));
		const later = transcript.flatMap((line, i) =>
			i > end && asked.some((q) => line.startsWith(q)) ? [transcript[i - 1] ?? '', line] : []
		);
		return [...transcript.slice(0, end), ...later];
	};

	it('prints help before every prompt on GitHub, and shows longer help on ?', async () => {
		await init(['github', '', 'github', '', '?', 'make check', '?', '', '', 'n']);
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
		writeTrackerModule();
		await init(['module', './tracker.mjs', 'github', '', 'make check', '', 'y', 'n']);
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

	it('writes nothing and creates no label on no', async () => {
		expect(await init(['github', '', 'github', '', 'make check', '', 'n'])).toBe(1);
		expect(existsSync(written())).toBe(false);
		expect(github.calls.filter((c) => c.method !== 'GET')).toEqual([]);
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

// the recap as it is read where nothing draws bold
const markdownRecap = (go = 'factory-go') => recap({ go, bold: (words) => `**${words}**` });

describe('nightjar init ends with the recap', () => {
	const answers = ['github', '', 'github', '', 'make check', '', ''];

	it.each([
		['after piped answers', answers, ['init']],
		['under --yes', [], ['init', '--yes', '--check', 'make check']]
	])('prints it last, %s, and offers nothing more', async (_how, given, argv) => {
		expect(await init(given, {}, argv)).toBe(0);
		expect(out.at(-1)).toBe(markdownRecap());
		expect(asked.filter((q) => q.includes('nightjar doctor'))).toEqual([]);
		expect(out.join('\n')).not.toContain('would build #1');
		expect(out.join('\n')).not.toContain('Your draft pull request');
		// off a terminal, .gitignore is left to the person
		expect(existsSync(join(m.root, '.gitignore'))).toBe(false);
		expect(out).toContain(
			'nightjar: add `.factory/` to .gitignore: Nightjar keeps its status and logs there'
		);
	});

	it('prints it over a factory.json that is there, with the name that file gives the Go', async () => {
		m.writeConfig({
			tracker: { type: 'github' },
			codeHost: { type: 'github' },
			check: 'make check',
			allowedCommands: [],
			signals: { go: 'build-me' }
		});
		expect(await init([])).toBe(0);
		expect(out.at(-1)).toBe(markdownRecap('build-me'));
		expect(existsSync(join(m.root, '.gitignore'))).toBe(false);
	});

	it('prints none when something is left to fix', async () => {
		github.refuseLabels();
		expect(await init(answers)).toBe(2);
		expect(out.join('\n')).not.toContain('From here on');
	});

	it('names the optional settings once, in one line, with the README link', async () => {
		expect(await init(answers)).toBe(0);
		const lines = out.filter((l) => l.includes('optional settings'));
		expect(lines).toEqual([
			'nightjar: optional settings, left out by init: setup, ports, trusted, rules, model, review and workflows; see https://github.com/nonameolsson/nightjar#configure-factoryjson'
		]);
	});

	it('names no optional settings when it keeps a factory.json', async () => {
		m.writeConfig({
			tracker: { type: 'github' },
			codeHost: { type: 'github' },
			check: 'make check',
			allowedCommands: []
		});
		expect(await init([])).toBe(0);
		expect(out.join('\n')).not.toContain('optional settings');
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
		expect(github.repoLabelNames()).toContain('factory-go');
		expect(out).toContain('  ok    Tracker: gh as ann on o/r');
	});

	it('runs no check: the check of a kept file was reported when it was written', async () => {
		m.writeConfig(config);
		expect(await init([])).toBe(0);
		expect(out.join('\n')).not.toContain('running the check');
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
		github = new FakeGitHub('acme/widgets', 'ann');
		const argv = ['init', '--tracker', 'github', '--code-host', 'github', '--check', 'make check'];
		expect(await init(['', '', ''], {}, [...argv, '--tracker-repo', 'acme/widgets'])).toBe(0);
		// piped answers are no terminal, so nothing is guessed
		expect(asked).toEqual([
			'GitHub repo the branch is pushed to, owner/name [o/r]: ',
			'Commands the Coding agent may run, separated by commas, or none (? for more) [make check]: ',
			'Write factory.json and go on, y or n [y]: '
		]);
		expect(m.readConfig()).toMatchObject({
			tracker: { repo: 'acme/widgets' },
			check: 'make check'
		});
	});
});

describe('nightjar init --dry-run', () => {
	const OPENING =
		'nightjar: dry run, so nothing is written or created; this is what init would do:';
	const expectNothingMade = () => {
		expect(asked).toEqual([]);
		expect(existsSync(written())).toBe(false);
		expect(existsSync(join(m.root, '.gitignore'))).toBe(false);
		expect(github.calls.filter((c) => c.method !== 'GET')).toEqual([]);
		expect(out.join('\n')).not.toContain('running the check');
		expect(out.join('\n')).not.toContain('From here on');
	};

	it('prints the summary and the preview, asks nothing and writes nothing', async () => {
		writeFileSync(join(m.root, 'Makefile'), 'check:\n\techo ok\n');
		expect(await init([], {}, ['init', '--dry-run'])).toBe(0);
		expect(err).toEqual([]);
		expect(out).toEqual([
			'nightjar: detected `make check` from Makefile "check"',
			OPENING,
			'  GitHub Issues + GitHub, repo o/r',
			'  check: make check',
			'  commands the Coding agent may run: make check',
			'  write:',
			'    factory.json:',
			'      {',
			'      \t"$schema": "https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json",',
			'      \t"tracker": {',
			'      \t\t"type": "github"',
			'      \t},',
			'      \t"codeHost": {',
			'      \t\t"type": "github"',
			'      \t},',
			'      \t"check": "make check",',
			'      \t"allowedCommands": [',
			'      \t\t"make check"',
			'      \t]',
			'      }',
			'  create the Signal labels on o/r: factory-go, ready-for-agent, agent-working, needs-info, ready-for-human',
			'  logins checked:',
			'    GitHub CLI for the Tracker, on o/r',
			'    GitHub CLI for the Code host, on o/r',
			'    claude, signed in to your Claude plan',
			'nightjar: add `.factory/` to .gitignore: Nightjar keeps its status and logs there'
		]);
		expectNothingMade();
	});

	it('shows the values its flags set, under --yes', async () => {
		const argv = [
			'init',
			'--dry-run',
			'--yes',
			'--check',
			'make verify',
			'--allowed-commands',
			'make verify, make lint *',
			'--tracker',
			'azure-devops',
			'--tracker-organization',
			'contoso',
			'--tracker-project',
			'Fabrikam',
			'--tracker-feature-type',
			'Epic',
			'--tracker-ticket-type',
			'Issue',
			'--code-host-repo',
			'fabrikam-app'
		];
		expect(await init([], {}, argv)).toBe(0);
		expect(err).toEqual([]);
		const shown = out.join('\n');
		expect(shown).toContain(
			'  Azure DevOps Boards + Azure Repos, repo contoso/Fabrikam/fabrikam-app'
		);
		expect(shown).toContain('  check: make verify');
		expect(shown).toContain('  commands the Coding agent may run: make verify, make lint *');
		expect(shown).toContain('"featureType": "Epic"');
		expect(shown).toContain('"ticketType": "Issue"');
		expect(shown).toContain('create no Signal labels');
		expect(shown).toContain('  logins checked:');
		expect(shown).not.toContain('<missing>');
		expectNothingMade();
	});

	it('names each value that has no default and no flag, and shows the rest', async () => {
		const argv = ['init', '--dry-run', '--tracker', 'azure-devops'];
		expect(await init([], {}, [...argv, '--tracker-organization', 'contoso'])).toBe(0);
		expect(err).toEqual([]);
		const shown = out.join('\n');
		expect(shown).toContain(
			'  Azure DevOps Boards + Azure Repos, repo contoso/<missing>/<missing>'
		);
		expect(shown).toContain('  check: <missing>');
		expect(shown).toContain('"featureType": "Feature"');
		expect(shown).toContain(
			'logins (only claude is checked until the Tracker and Code host lack no value):'
		);
		expect(out.filter((l) => l.includes('found no default for'))).toEqual([
			'nightjar: --yes found no default for: Project that holds the Features; pass --tracker-project',
			'nightjar: --yes found no default for: Git repo on Azure Repos, by name; pass --code-host-repo',
			'nightjar: --yes found no default for: Command that checks the work, run after each Ticket; pass --check'
		]);
		expect(out.at(-1)).toBe(
			'nightjar: `init --yes` would write nothing until each of these is given'
		);
		expectNothingMade();
	});

	it('goes on past a GitHub repo that origin does not name', async () => {
		spawnSync('git', ['remote', 'set-url', 'origin', 'https://example.com/o/app.git'], {
			cwd: m.root,
			env: m.env
		});
		expect(await init([], {}, ['init', '--dry-run', '--check', 'make check'])).toBe(0);
		expect(out).toContain('  GitHub Issues + GitHub, repo <missing>');
		expect(out.filter((l) => l.includes('pass --tracker-repo'))).toHaveLength(1);
		expect(out.filter((l) => l.includes('pass --code-host-repo'))).toHaveLength(1);
		expectNothingMade();
	});

	it('refuses a flag whose value the schema does not take, as --yes does', async () => {
		const argv = ['init', '--dry-run', '--tracker-repo', 'nope', '--check', 'make check'];
		expect(await init([], {}, argv)).toBe(2);
		expect(err.join('\n')).toContain('--tracker-repo nope: must be owner/name');
		expectNothingMade();
	});

	it('exits 2 and lists the failures of the machine check', async () => {
		github.signOut();
		const env = { FAKE_CLAUDE_SIGNED_OUT: '1' };
		expect(await init([], env, ['init', '--dry-run'])).toBe(2);
		expect(err.join('\n')).toMatch(/FAIL {2}Tracker: .*run `gh auth login`/);
		expect(err.join('\n')).toMatch(/FAIL {2}claude: .*not signed in/);
		expect(err.at(-1)).toContain('3 problems above, and nothing was written');
		expect(out.join('\n')).not.toContain(OPENING);
		expectNothingMade();
	});

	it('shows a factory.json that is there, with its Signal names, and creates no label', async () => {
		m.writeConfig({
			tracker: { type: 'github' },
			codeHost: { type: 'github' },
			check: 'make check',
			allowedCommands: [],
			signals: { go: 'build-me' }
		});
		const before = readFileSync(written(), 'utf8');
		expect(await init([], {}, ['init', '--dry-run'])).toBe(0);
		expect(out).toContain('nightjar: factory.json is there already; init would keep it');
		expect(out).toContain('  commands the Coding agent may run: none');
		expect(out.join('\n')).toContain('create the Signal labels on o/r: build-me, ');
		expect(out).not.toContain('  write:');
		expect(out.join('\n')).not.toContain('From here on');
		expect(readFileSync(written(), 'utf8')).toBe(before);
		expect(github.repoLabelNames()).toEqual([]);
	});

	it('is listed in the usage, with --no-tour', async () => {
		expect(await init([], {}, ['init', 'now'])).toBe(2);
		expect(err.join('\n')).toContain('usage: nightjar init [--yes] [--dry-run] [--no-tour]');
	});
});

describe('nightjar init on a terminal', () => {
	type Picks = (string | string[] | boolean | null)[];
	const SUMMARY_QUESTION = 'Set up Nightjar like this?';
	// each prompt shown, with the answer it offered
	let offered: [string, unknown][];
	beforeEach(() => {
		offered = [];
	});

	// scripted picks; a pick is a value, or a list of values for a multi-select
	function withUi(picks: Picks): Prompter {
		const left = [...picks];
		const next = (message: string, initial: unknown) => {
			if (left.length === 0) throw new Error(`no pick left for: ${message}`);
			transcript.push(message);
			offered.push([message, initial]);
			return left.shift();
		};
		return {
			// like a terminal, a refused answer is shown and asked again
			text: (message, fallback, accept) => {
				for (;;) {
					const got = (next(message, fallback) as string) || (fallback ?? '');
					const printed = out.length;
					const problem = accept(got);
					// a line printed while a prompt is drawn garbles it
					if (out.length !== printed) transcript.push('<printed during a prompt>');
					if (problem === null) return Promise.resolve(got);
					transcript.push(problem);
				}
			},
			select: (message, _choices, initial) => Promise.resolve(next(message, initial) as string),
			multiselect: (message, choices, initial) => {
				transcript.push(`${message} [${choices.map((c) => c.value).join(' | ')}]`);
				offered.push([message, initial]);
				return Promise.resolve(left.shift() as string[]);
			},
			confirm: (message, initial) => Promise.resolve(next(message, initial) as boolean | null),
			note: (text) => void transcript.push(text)
		};
	}
	const initUi = (
		picks: Picks,
		argv: string[] = ['init'],
		prompter = withUi(picks),
		ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com')
	) => {
		return runNightjar(argv, {
			os: { platform: 'linux', kernel: '' },
			cwd: m.root,
			env: m.env,
			gh: github.gh,
			request: ado.request,
			prompter
		});
	};

	const gitignore = () => join(m.root, '.gitignore');
	const makefile = (...targets: string[]) =>
		writeFileSync(join(m.root, 'Makefile'), targets.map((t) => `${t}:\n\techo ok\n`).join(''));
	const twoChecks = () => {
		makefile('test');
		writeFileSync(join(m.root, 'go.mod'), 'module x\n');
	};
	const summary = () => {
		const start = transcript.indexOf('nightjar: this is what init will do:');
		return transcript.slice(start, transcript.indexOf(SUMMARY_QUESTION) + 1);
	};
	const ansiRecap = () => recap({ go: 'factory-go', bold: (words) => `\x1b[1m${words}\x1b[22m` });
	// the Tracker and Code host questions on GitHub, taking the repo each offers
	const github4 = ['github', '', 'github', ''];

	it('asks one yes or no when the repo names one check, then writes and ends with the recap', async () => {
		makefile('check');
		expect(await initUi([true])).toBe(0);
		expect(err).toEqual([]);
		expect(offered).toEqual([[SUMMARY_QUESTION, true]]);
		expect(m.readConfig()).toEqual({
			$schema: 'https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json',
			tracker: { type: 'github' },
			codeHost: { type: 'github' },
			check: 'make check',
			allowedCommands: ['make check']
		});
		expect(readFileSync(gitignore(), 'utf8')).toBe('.factory/\n');
		expect(out).toContain('nightjar: added `.factory/` to .gitignore');
		expect(out.join('\n')).not.toContain('add `.factory/` to .gitignore: Nightjar');
		expect(github.repoLabelNames()).toContain('factory-go');
		expect(out).toContain('nightjar: running the check once on this checkout: make check');
		expect(out.at(-1)).toBe(ansiRecap());
		expect(out.join('\n')).not.toContain('Your draft pull request');
		const commits = spawnSync('git', ['rev-list', '--all', '--count'], {
			cwd: m.root,
			env: m.env,
			encoding: 'utf8'
		});
		expect(commits.stdout.trim()).toBe('0');
	});

	it('shows one summary of the guesses and of what it will do, before it writes', async () => {
		makefile('check');
		writeFileSync(join(m.root, 'package.json'), '{"scripts":{"lint":"x"}}');
		await initUi([true]);
		expect(summary()).toEqual([
			'nightjar: this is what init will do:',
			'  GitHub Issues + GitHub, repo o/r',
			'  check: make check',
			'  commands the Coding agent may run: make check, npm run lint',
			'  write:',
			'    factory.json',
			'    .gitignore, adding the line .factory/',
			'  create the Signal labels on o/r: factory-go, ready-for-agent, agent-working, needs-info, ready-for-human',
			'  logins checked:',
			'    GitHub CLI for the Tracker, on o/r',
			'    GitHub CLI for the Code host, on o/r',
			'    claude, signed in to your Claude plan',
			'No asks each question, with these as the defaults. Any answer can be edited later in factory.json.',
			SUMMARY_QUESTION
		]);
		expect(transcript.indexOf('nightjar: wrote factory.json')).toBeGreaterThan(
			transcript.indexOf(SUMMARY_QUESTION)
		);
	});

	it.each([
		['appends to one that lacks it', 'node_modules', 'node_modules\n.factory/\n'],
		['leaves one that has it', 'node_modules\n.factory/\n', null],
		['leaves one that has it from the root', '/.factory\n', null],
		['leaves one that has it at any depth', '**/.factory/\n', null],
		['leaves one that ignores what it holds', '.factory/*\n', null]
	])('.gitignore: %s', async (_what, before, after) => {
		makefile('check');
		writeFileSync(gitignore(), before);
		expect(await initUi([true])).toBe(0);
		expect(readFileSync(gitignore(), 'utf8')).toBe(after ?? before);
		expect(summary().some((l) => l.includes('.gitignore'))).toBe(after !== null);
	});

	it('takes the commands of --allowed-commands over its guess', async () => {
		makefile('check');
		expect(await initUi([true], ['init', '--allowed-commands', 'make lint *'])).toBe(0);
		expect(m.readConfig()).toMatchObject({ allowedCommands: ['make lint *'] });
	});

	it('asks which check when the repo names several, then the one yes or no', async () => {
		twoChecks();
		expect(await initUi(['go test ./...', true])).toBe(0);
		expect(offered.map(([q]) => q)).toEqual([
			'Command that checks the work, run after each Ticket',
			SUMMARY_QUESTION
		]);
		expect(m.readConfig()).toMatchObject({ check: 'go test ./...' });
	});

	it('asks for the check when the repo names none, then the one yes or no', async () => {
		expect(await initUi(['make verify', true])).toBe(0);
		expect(out.join('\n')).toContain('no check command detected');
		expect(offered.map(([q]) => q)).toEqual([
			'Command that checks the work, run after each Ticket (? for more)',
			SUMMARY_QUESTION
		]);
		expect(m.readConfig()).toMatchObject({ check: 'make verify' });
	});

	it('asks each question on no, offering the guesses, then asks again before it writes', async () => {
		makefile('check');
		const picks = [false, ...github4, '', ['make check'], '', true];
		expect(await initUi(picks)).toBe(0);
		expect(offered).toEqual([
			[SUMMARY_QUESTION, true],
			['Tracker', 'github'],
			['GitHub repo whose issues are the Features, owner/name', 'o/r'],
			['Code host', 'github'],
			['GitHub repo the branch is pushed to, owner/name', 'o/r'],
			['Command that checks the work, run after each Ticket (? for more)', 'make check'],
			['Commands the Coding agent may run', ['make check']],
			['Others, separated by commas (empty for none)', ''],
			[SUMMARY_QUESTION, true]
		]);
		expect(transcript).toContain(
			'No writes nothing. Any answer can be edited later in factory.json.'
		);
		expect(readFileSync(gitignore(), 'utf8')).toBe('.factory/\n');
	});

	it.each([
		['a picked check', ['go test ./...'], 'go test ./...', [['go test ./...']]],
		['a typed check', ['\0own', 'make verify'], 'make verify', [['\0own'], ['make verify']]]
	])('offers %s again after no, among several', async (_what, first, check, defaults) => {
		twoChecks();
		const again = first.map(() => '');
		again[0] = first[0] ?? '';
		const picks = [...first, false, ...github4, ...again, [check], '', true];
		expect(await initUi(picks)).toBe(0);
		const start = offered.findIndex(([q]) => q === 'Code host') + 2;
		expect(offered.slice(start, start + defaults.length).map(([, d]) => [d])).toEqual(defaults);
		expect(m.readConfig()).toMatchObject({ check });
	});

	it('offers a typed check again after no, when the repo names none', async () => {
		const picks = ['make verify', false, ...github4, '', ['make verify'], '', true];
		expect(await initUi(picks)).toBe(0);
		expect(offered).toContainEqual([
			'Command that checks the work, run after each Ticket (? for more)',
			'make verify'
		]);
		expect(m.readConfig()).toMatchObject({ check: 'make verify' });
	});

	it('writes nothing on no to what the questions came to', async () => {
		makefile('check');
		expect(await initUi([false, ...github4, '', ['make check'], '', false])).toBe(1);
		expect(existsSync(written())).toBe(false);
		expect(existsSync(gitignore())).toBe(false);
		expect(github.repoLabelNames()).toEqual([]);
		expect(out).toContain('nightjar: wrote nothing; run `nightjar init` again to start over');
		expect(out.join('\n')).not.toContain('From here on');
	});

	it('writes nothing when the person cancels at the summary', async () => {
		makefile('check');
		expect(await initUi([null])).toBe(2);
		expect(err.join('\n')).toContain(`cancelled at: ${SUMMARY_QUESTION}`);
		expect(existsSync(written())).toBe(false);
		expect(existsSync(gitignore())).toBe(false);
	});

	it('asks the questions at once when a flag names another pair', async () => {
		const argv = [
			'init',
			'--tracker',
			'azure-devops',
			'--tracker-organization',
			'contoso',
			'--tracker-project',
			'Fabrikam',
			'--code-host',
			'github',
			'--check',
			'make check'
		];
		expect(await initUi(['', '', '', ['make check'], '', true], argv)).toBe(0);
		expect(offered[0]?.[0]).toContain('Work item type that plays the Feature');
		expect(offered.filter(([q]) => q === SUMMARY_QUESTION)).toHaveLength(1);
		expect(summary()).toContain(
			'  Azure DevOps Boards + GitHub, Tracker on contoso/Fabrikam, repo o/r'
		);
		expect(readFileSync(gitignore(), 'utf8')).toBe('.factory/\n');
	});

	it('asks the questions at once when origin is not on GitHub', async () => {
		spawnSync('git', ['remote', 'set-url', 'origin', 'https://example.com/o/app.git'], {
			cwd: m.root,
			env: m.env
		});
		const picks = ['github', 'o/r', 'github', 'o/r', 'make check', ['make check'], '', true];
		expect(await initUi(picks)).toBe(0);
		expect(offered[0]?.[0]).toBe('Tracker');
		expect(summary()).toContain('  GitHub Issues + GitHub, repo o/r');
	});

	it('stops after the writes under --no-tour, with the recap', async () => {
		makefile('check');
		expect(await initUi([true], ['init', '--no-tour'])).toBe(0);
		expect(existsSync(written())).toBe(true);
		expect(readFileSync(gitignore(), 'utf8')).toBe('.factory/\n');
		expect(out.at(-1)).toBe(ansiRecap());
	});

	it('guesses nothing and leaves .gitignore alone under --yes', async () => {
		expect(await initUi([], ['init', '--yes', '--check', 'make check'])).toBe(0);
		expect(offered).toEqual([]);
		expect(existsSync(gitignore())).toBe(false);
		expect(out.at(-1)).toBe(markdownRecap());
	});

	it.each([
		['the .gitignore line the tour would write', ['init', '--dry-run'], true],
		['no .gitignore write under --yes, which makes none', ['init', '--dry-run', '--yes'], false]
	])('shows %s in a dry run, prompting for nothing', async (_what, argv, writes) => {
		twoChecks();
		expect(await initUi([], argv)).toBe(0);
		expect(offered).toEqual([]);
		expect(out).toContain(
			'nightjar: detected several check commands; taking the first, `make test`'
		);
		expect(out.includes('    .gitignore, adding the line .factory/')).toBe(writes);
		expect(out.some((l) => l.startsWith('nightjar: add `.factory/`'))).toBe(!writes);
		expect(existsSync(written())).toBe(false);
		expect(existsSync(gitignore())).toBe(false);
	});

	it('takes a picked check and the ticked allowed commands', async () => {
		twoChecks();
		const code = await initUi([
			'go test ./...',
			false,
			...github4,
			'go test ./...',
			['make test'],
			'make lint',
			true
		]);
		expect(code).toBe(0);
		expect(m.readConfig()).toMatchObject({
			check: 'go test ./...',
			allowedCommands: ['make test', 'make lint']
		});
		expect(transcript.join('\n')).toMatch(/Commands the Coding agent may run \[.*make test/);
	});

	it('refuses a list of numbers typed as my own check', async () => {
		twoChecks();
		expect(await initUi(['\0own', '1,2', 'make check', true])).toBe(0);
		expect(transcript.join('\n')).toContain('the check is a single command');
		expect(m.readConfig()).toMatchObject({ check: 'make check' });
	});

	it('shows the longer help for ?, and takes the answer after it', async () => {
		expect(await initUi(['?', 'make check', true])).toBe(0);
		expect(transcript.join('\n')).toContain('Keep it fast and deterministic');
		expect(m.readConfig()).toMatchObject({ check: 'make check' });
	});

	it('warns about a check that can never fail after the prompt, not inside it', async () => {
		expect(await initUi(['true', true])).toBe(0);
		expect(out.join('\n')).toContain('`true` can never fail');
		expect(transcript).not.toContain('<printed during a prompt>');
	});

	it('writes nothing when the person cancels a question', async () => {
		const prompter = { ...withUi([]), text: () => Promise.resolve(null) };
		expect(await initUi([], ['init'], prompter)).toBe(2);
		expect(err.join('\n')).toContain('cancelled');
		expect(existsSync(written())).toBe(false);
	});

	describe('with an Azure DevOps origin', () => {
		const FEATURE_QUESTION =
			'Work item type that plays the Feature, such as Feature, Epic or Product Backlog Item';
		const TICKET_QUESTION = 'Work item type of a Ticket, for `nightjar create`';
		let ado: FakeAzureDevOps;
		beforeEach(() => {
			ado = azureProject();
			setOrigin('https://dev.azure.com/contoso/Fabrikam/_git/fabrikam-app');
			makefile('check');
		});

		it('asks one yes or no, and writes a factory.json with ticketType', async () => {
			expect(await initUi([true], ['init'], undefined, ado)).toBe(0);
			expect(err).toEqual([]);
			expect(offered).toEqual([[SUMMARY_QUESTION, true]]);
			expect(summary()).toEqual([
				'nightjar: this is what init will do:',
				'  Azure DevOps Boards + Azure Repos, repo contoso/Fabrikam/fabrikam-app',
				'  check: make check',
				'  commands the Coding agent may run: make check',
				'  write:',
				'    factory.json',
				'    .gitignore, adding the line .factory/',
				'  create no Signal labels: Azure DevOps shows Signals as tags on first use',
				'  logins checked:',
				'    Azure CLI for the Tracker, on contoso/Fabrikam',
				'    Azure CLI for the Code host, on contoso/Fabrikam/fabrikam-app',
				'    claude, signed in to your Claude plan',
				'No asks each question, with these as the defaults. Any answer can be edited later in factory.json.',
				SUMMARY_QUESTION
			]);
			expect(m.readConfig()).toEqual({
				$schema: 'https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json',
				...azurePair('Feature', 'User Story'),
				check: 'make check',
				allowedCommands: ['make check']
			});
		});

		it('asks for the two types of a custom process, then the one yes or no', async () => {
			ado.process = { custom: 'Contoso XML' };
			expect(await initUi(['Epic', 'Task', true], ['init'], undefined, ado)).toBe(0);
			expect(offered).toEqual([
				[FEATURE_QUESTION, 'Feature'],
				[TICKET_QUESTION, undefined],
				[SUMMARY_QUESTION, true]
			]);
			expect(out.join('\n')).toContain('the process of contoso/Fabrikam, Contoso XML, is not');
			expect(m.readConfig()).toMatchObject(azurePair('Epic', 'Task'));
		});

		it('takes no empty Ticket type where the process names none', async () => {
			ado.process = { custom: 'Contoso XML' };
			expect(await initUi(['', '', 'Task', true], ['init'], undefined, ado)).toBe(0);
			expect(transcript).toContain('name the work item type of a Ticket, such as User Story');
			expect(m.readConfig()).toMatchObject(azurePair('Feature', 'Task'));
		});

		it('asks each question on no, with the guesses as the defaults', async () => {
			ado.process = { system: 'Scrum' };
			const azure = ['azure-devops', '', ''];
			const picks = [false, ...azure, '', '', ...azure, '', '', ['make check'], '', true];
			expect(await initUi(picks, ['init'], undefined, ado)).toBe(0);
			expect(offered.slice(1, 10)).toEqual([
				['Tracker', 'azure-devops'],
				['Azure DevOps organization, as in dev.azure.com/<organization>', 'contoso'],
				['Project that holds the Features', 'Fabrikam'],
				[FEATURE_QUESTION, 'Feature'],
				[TICKET_QUESTION, 'Product Backlog Item'],
				['Code host', 'azure-devops'],
				['Azure DevOps organization, as in dev.azure.com/<organization>', 'contoso'],
				['Project that holds the repo', 'Fabrikam'],
				['Git repo on Azure Repos, by name', 'fabrikam-app']
			]);
			expect(m.readConfig()).toMatchObject(azurePair('Feature', 'Product Backlog Item'));
		});
	});
});

// a project as the origins below name it, with its repo
function azureProject() {
	const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
	ado.repository('fabrikam-app');
	return ado;
}

const setOrigin = (url: string) =>
	spawnSync('git', ['remote', 'set-url', 'origin', url], { cwd: m.root, env: m.env });

const azurePair = (featureType: string, ticketType: string) => {
	const where = { type: 'azure-devops', organization: 'contoso', project: 'Fabrikam' };
	return {
		tracker: { ...where, featureType, ticketType },
		codeHost: { ...where, repo: 'fabrikam-app' }
	};
};

describe('nightjar init from an Azure DevOps origin', () => {
	let ado: FakeAzureDevOps;
	beforeEach(() => {
		ado = azureProject();
		setOrigin('https://dev.azure.com/contoso/Fabrikam/_git/fabrikam-app');
	});

	const yes = (...flags: string[]) =>
		runNightjar(['init', '--yes', '--check', 'make check', ...flags], {
			os: { platform: 'linux', kernel: '' },
			cwd: m.root,
			env: m.env,
			gh: github.gh,
			request: ado.request
		});
	const dryRun = () =>
		runNightjar(['init', '--dry-run', '--check', 'make check'], {
			os: { platform: 'linux', kernel: '' },
			cwd: m.root,
			env: m.env,
			gh: github.gh,
			request: ado.request
		});
	const processReads = () => ado.asked.filter((c) => c.url.includes('/_apis/projects/'));

	it.each([
		'https://dev.azure.com/contoso/Fabrikam/_git/fabrikam-app',
		'git@ssh.dev.azure.com:v3/contoso/Fabrikam/fabrikam-app',
		'contoso@vs-ssh.visualstudio.com:v3/contoso/Fabrikam/fabrikam-app',
		'https://contoso.visualstudio.com/Fabrikam/_git/fabrikam-app'
	])('takes the organization, project and repo from %s', async (url) => {
		setOrigin(url);
		expect(await yes()).toBe(0);
		expect(err).toEqual([]);
		expect(m.readConfig()).toMatchObject(azurePair('Feature', 'User Story'));
	});

	it.each<[string, FakeProcess, string, string]>([
		['Agile', { system: 'Agile' }, 'Feature', 'User Story'],
		['Scrum', { system: 'Scrum' }, 'Feature', 'Product Backlog Item'],
		['Basic', { system: 'Basic' }, 'Epic', 'Issue'],
		['CMMI', { system: 'CMMI' }, 'Feature', 'Requirement'],
		[
			'one that inherits from Scrum',
			{ inherited: 'Contoso Scrum', from: 'Scrum' },
			'Feature',
			'Product Backlog Item'
		]
	])('takes the types of the process: %s', async (_name, process, feature, ticket) => {
		ado.process = process;
		expect(await yes()).toBe(0);
		expect(m.readConfig()).toMatchObject(azurePair(feature, ticket));
	});

	it('names both types as missing under --yes on a custom process, and writes nothing', async () => {
		ado.process = { custom: 'Contoso XML' };
		expect(await yes()).toBe(2);
		expect(err.join('\n')).toContain('pass --tracker-feature-type');
		expect(err.join('\n')).toContain('pass --tracker-ticket-type');
		expect(existsSync(written())).toBe(false);
	});

	it('names only the type no flag gives on a custom process', async () => {
		ado.process = { custom: 'Contoso XML' };
		expect(await yes('--tracker-feature-type', 'Epic')).toBe(2);
		expect(err.join('\n')).not.toContain('pass --tracker-feature-type');
		expect(err.join('\n')).toContain('pass --tracker-ticket-type');
	});

	it('reads no process when flags name both types', async () => {
		ado.process = { custom: 'Contoso XML' };
		const types = ['--tracker-feature-type', 'Epic', '--tracker-ticket-type', 'Task'];
		expect(await yes(...types)).toBe(0);
		expect(m.readConfig()).toMatchObject(azurePair('Epic', 'Task'));
		expect(processReads()).toEqual([]);
	});

	it('says why a process cannot be read, and takes it as one that names no types', async () => {
		ado.failNext(/_apis\/projects\//, 403);
		expect(await yes()).toBe(2);
		expect(out.join('\n')).toContain('could not read the process of contoso/Fabrikam: ');
		expect(err.join('\n')).toContain('pass --tracker-ticket-type');
		expect(existsSync(written())).toBe(false);
	});

	it('lets field flags win over the guesses', async () => {
		ado.repository('other-app');
		const flags = ['--tracker-ticket-type', 'Bug', '--code-host-repo', 'other-app'];
		expect(await yes(...flags)).toBe(0);
		expect(m.readConfig()).toMatchObject({
			tracker: { featureType: 'Feature', ticketType: 'Bug' },
			codeHost: { repo: 'other-app' }
		});
	});

	it('refuses an empty Ticket type, which is always written here', async () => {
		expect(await yes('--tracker-ticket-type', '')).toBe(2);
		expect(err.join('\n')).toContain('name the work item type of a Ticket');
		expect(existsSync(written())).toBe(false);
	});

	it('keeps the mixed pair a flag names, with the other half from origin', async () => {
		expect(await yes('--code-host', 'github', '--code-host-repo', 'o/r')).toBe(0);
		expect(m.readConfig()).toMatchObject({
			tracker: { organization: 'contoso', project: 'Fabrikam', featureType: 'Feature' },
			codeHost: { type: 'github', repo: 'o/r' }
		});
		expect(JSON.stringify(m.readConfig())).not.toContain('ticketType');
		expect(processReads()).toEqual([]);
	});

	it('reads no process before the sign-in is checked', async () => {
		m.env.FAKE_AZ_SIGNED_OUT = '1';
		expect(await yes()).toBe(2);
		expect(err.join('\n')).toMatch(/FAIL {2}Tracker: .*az login/);
		expect(processReads()).toEqual([]);
	});

	it('shows the guesses in a dry run, and writes nothing', async () => {
		ado.process = { system: 'Basic' };
		expect(await dryRun()).toBe(0);
		const shown = out.join('\n');
		expect(shown).toContain(
			'  Azure DevOps Boards + Azure Repos, repo contoso/Fabrikam/fabrikam-app'
		);
		expect(shown).toContain('"featureType": "Epic"');
		expect(shown).toContain('"ticketType": "Issue"');
		expect(shown).not.toContain('<missing>');
		expect(existsSync(written())).toBe(false);
	});

	it('shows both types as missing in a dry run on a custom process', async () => {
		ado.process = { custom: 'Contoso XML' };
		expect(await dryRun()).toBe(0);
		const shown = out.join('\n');
		expect(shown).toContain('"featureType": "<missing>"');
		expect(shown).toContain('"ticketType": "<missing>"');
		expect(shown).toContain('pass --tracker-feature-type');
		expect(shown).toContain('pass --tracker-ticket-type');
	});

	it('guesses nothing from it for piped answers', async () => {
		expect(await init([])).toBe(2);
		expect(asked).toEqual(['Tracker: github, azure-devops, module [github]: ']);
		expect(processReads()).toEqual([]);
	});
});
