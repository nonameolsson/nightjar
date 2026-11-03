// What each Tracker needs done so its Signals show: labels on GitHub, nothing on Azure DevOps.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAdapters } from './adapters.js';
import type { Config } from './config.js';
import { oneEscape } from './fakes/github.js';
import { machine, type Machine } from './fakes/machine.js';
import { FakeGitHub } from './github/fake-github.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';

let m: Machine;
afterEach(() => m.remove());

const config = (over: Partial<Config>): Config => ({
	tracker: { type: 'github' },
	codeHost: { type: 'github' },
	check: 'make check',
	allowedCommands: [],
	signals: DEFAULT_SIGNAL_NAMES,
	...over
});

describe('Adapters.prepareSignals', () => {
	it('creates the labels on the GitHub repo the Tracker names, which origin gives when it names none', async () => {
		m = machine();
		const github = oneEscape();
		const adapters = await makeAdapters(config({}), m.root, m.env, { gh: github.gh });
		const said = await adapters.prepareSignals();
		expect(said).toContain('created the label factory-go');
		expect(github.repoLabelNames()).toContain('factory-go');
	});

	it('creates them under the names factory.json gives', async () => {
		m = machine();
		const signals = { ...DEFAULT_SIGNAL_NAMES, go: 'ship-it' };
		const tracker = { type: 'github' as const, repo: 'acme/widgets' };
		const github = new FakeGitHub('acme/widgets', 'ann');
		const adapters = await makeAdapters(config({ signals, tracker }), m.root, m.env, {
			gh: github.gh
		});
		await adapters.prepareSignals();
		expect(github.repoLabelNames()).toContain('ship-it');
	});

	it('says tags appear on first use on Azure DevOps, and creates nothing', async () => {
		m = machine();
		const tracker = {
			type: 'azure-devops' as const,
			organization: 'contoso',
			project: 'Fabrikam',
			featureType: 'Feature'
		};
		const github = oneEscape();
		const adapters = await makeAdapters(config({ tracker }), m.root, m.env, { gh: github.gh });
		expect(await adapters.prepareSignals()).toEqual([
			'Azure DevOps shows Signals as tags, which appear on first use: there is nothing to create.'
		]);
		expect(github.calls).toEqual([]);
		expect(m.calls('az')).toBe('');
	});

	it('leaves the Signals to a Tracker module', async () => {
		m = machine();
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
		const body = methods.map((name) => `${name}: () => {}`).join(', ');
		writeFileSync(join(m.root, 'tracker.mjs'), `export const createTracker = () => ({ ${body} });`);
		const tracker = { type: 'module' as const, path: './tracker.mjs' };
		const adapters = await makeAdapters(config({ tracker }), m.root, m.env);
		expect(await adapters.prepareSignals()).toEqual([
			'./tracker.mjs shows Signals its own way: Nightjar creates nothing for it.'
		]);
	});
});
