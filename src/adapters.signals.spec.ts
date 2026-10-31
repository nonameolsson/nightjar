// What each Tracker needs done so its Signals show: labels on GitHub, nothing on Azure DevOps.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAdapters } from './adapters.js';
import type { Config } from './config.js';
import { machine, type Machine } from './fakes/machine.js';
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
		const adapters = await makeAdapters(config({}), m.root, m.env);
		const said = await adapters.prepareSignals();
		expect(said).toContain('created the label factory-go');
		expect(m.calls('gh')).toMatch(/-X POST repos\/o\/r\/labels -f name=factory-go /);
	});

	it('creates them under the names factory.json gives', async () => {
		m = machine();
		const signals = { ...DEFAULT_SIGNAL_NAMES, go: 'ship-it' };
		const tracker = { type: 'github' as const, repo: 'acme/widgets' };
		const adapters = await makeAdapters(config({ signals, tracker }), m.root, m.env);
		await adapters.prepareSignals();
		expect(m.calls('gh')).toMatch(/-X POST repos\/acme\/widgets\/labels -f name=ship-it /);
	});

	it('says tags appear on first use on Azure DevOps, and creates nothing', async () => {
		m = machine();
		const tracker = {
			type: 'azure-devops' as const,
			organization: 'contoso',
			project: 'Fabrikam',
			featureType: 'Feature'
		};
		const adapters = await makeAdapters(config({ tracker }), m.root, m.env);
		expect(await adapters.prepareSignals()).toEqual([
			'Azure DevOps shows Signals as tags, which appear on first use: there is nothing to create.'
		]);
		expect(m.calls('gh')).toBe('');
		expect(m.calls('az')).toBe('');
	});

	it('leaves the Signals to a Tracker module', async () => {
		m = machine();
		const methods = [
			'me',
			'assignedFeatures',
			'feature',
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
