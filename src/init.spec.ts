// `nightjar init` by its output and the files it writes, over a machine of stand-ins for gh, az and
// claude and scripted answers, so it needs no terminal.
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
beforeEach(() => {
	out = [];
	err = [];
	asked = [];
	m = machine();
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
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
			return Promise.resolve(left.shift() ?? null);
		}
	});
}

const written = () => join(m.root, 'factory.json');

describe('nightjar init on GitHub', () => {
	it('writes a factory.json that passes the schema, from the answers', async () => {
		expect(await init(['github', '', 'github', '', 'make check', 'make check, make test'])).toBe(0);
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
		await init(['github', 'acme/widgets', 'github', '', 'make check', '']);
		expect(asked[1]).toContain('[o/r]');
		expect(m.readConfig()).toMatchObject({
			tracker: { type: 'github', repo: 'acme/widgets' },
			codeHost: { type: 'github' }
		});
	});

	it('creates the Signal labels and says so', async () => {
		await init(['github', '', 'github', '', 'make check', '']);
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
		await init(['github', '', 'github', '', 'make check', ''], {
			FAKE_GH_EXISTING: 'factory-go,needs-info'
		});
		expect(out).toContain('nightjar: the label factory-go exists already');
		expect(out).toContain('nightjar: created the label agent-working');
	});

	it('checks every login, listing what it found', async () => {
		await init(['github', '', 'github', '', 'make check', '']);
		expect(out).toContain('  ok    Tracker: gh as ann on o/r');
		expect(out).toContain('  ok    claude: 2.1.314 (Claude Code), signed in');
	});

	it('says how to fix a login that is missing, and creates no label with it', async () => {
		const code = await init(['github', '', 'github', '', 'make check', ''], {
			FAKE_GH_SIGNED_OUT: '1',
			FAKE_CLAUDE_SIGNED_OUT: '1'
		});
		expect(code).toBe(2);
		expect(err.join('\n')).toMatch(/FAIL {2}Tracker: .*run `gh auth login`/);
		expect(err.join('\n')).toMatch(/FAIL {2}claude: .*run `claude auth login`/);
		expect(out.join('\n')).toContain('Signal labels not created');
		expect(m.calls('gh')).not.toContain('POST');
		// the file is written all the same, and init can be run again
		expect(existsSync(written())).toBe(true);
	});

	it('says what to do when the labels cannot be created', async () => {
		const code = await init(['github', '', 'github', '', 'make check', ''], {
			FAKE_GH_NO_LABELS: '1'
		});
		expect(code).toBe(2);
		expect(err.join('\n')).toContain('FAIL  Signals: gh could not create the label factory-go');
	});
});

describe('nightjar init asks, never guesses', () => {
	it('asks for the check command with no default, and asks again when it is left empty', async () => {
		expect(await init(['github', '', 'github', '', '', '  ', 'make check', ''])).toBe(0);
		const check = asked.filter((q) => q.includes('checks the work'));
		expect(check).toHaveLength(3);
		expect(check.every((q) => !q.includes('['))).toBe(true);
		expect(out).toContain('  name the command that checks the work');
		expect(m.readConfig()).toMatchObject({ check: 'make check' });
	});

	it('writes nothing when the input ends before the check command is given', async () => {
		expect(await init(['github', '', 'github', ''])).toBe(2);
		expect(err.join('\n')).toContain('the input ended before this was answered');
		expect(existsSync(written())).toBe(false);
	});

	it('asks again for a Tracker it does not know, and a repo that is not owner/name', async () => {
		await init(['svn', 'github', 'nope', 'acme/widgets', 'github', '', 'make check', '']);
		expect(out.join('\n')).toContain('  choose github, azure-devops or module');
		expect(out.join('\n')).toContain('  must be owner/name');
		expect(m.readConfig()).toMatchObject({ tracker: { repo: 'acme/widgets' } });
	});

	it('takes none for an empty list of commands the agent may run', async () => {
		await init(['github', '', 'github', '', 'make check', 'none']);
		expect(m.readConfig()).toMatchObject({ allowedCommands: [] });
	});

	it('offers the check command as the command the agent may run', async () => {
		await init(['github', '', 'github', '', 'make check', '']);
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
		await init(['module', './tracker.mjs', 'github', '', 'make check', '']);
		expect(m.readConfig()).toMatchObject({ tracker: { type: 'module', path: './tracker.mjs' } });
		expect(out).toContain(
			'nightjar: ./tracker.mjs shows Signals its own way: Nightjar creates nothing for it.'
		);
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
	it('takes only --use-api-key', async () => {
		expect(await init([], {}, ['init', 'now'])).toBe(2);
		expect(err.join('\n')).toContain('unknown argument now');
	});
});
