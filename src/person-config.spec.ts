import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from './config.js';
import { loadPersonConfig, personConfigPath } from './person-config.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'nightjar-person-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (folder: string, value: unknown) => {
	mkdirSync(join(folder, 'nightjar'), { recursive: true });
	writeFileSync(join(folder, 'nightjar', 'config.json'), JSON.stringify(value));
};

describe('personConfigPath', () => {
	it('is under XDG_CONFIG_HOME when set, else ~/.config', () => {
		expect(personConfigPath({ HOME: '/home/ann', XDG_CONFIG_HOME: '/xdg' })).toBe(
			'/xdg/nightjar/config.json'
		);
		expect(personConfigPath({ HOME: '/home/ann' })).toBe('/home/ann/.config/nightjar/config.json');
	});
});

describe('loadPersonConfig', () => {
	it('gives the defaults when there is no file: $60 a day, the signed-in person', () => {
		expect(loadPersonConfig({ HOME: dir })).toEqual({ dailyUsd: 60 });
	});

	it('reads the daily spend cap and whose Features to build', () => {
		write(join(dir, '.config'), { dailyUsd: 25, assignee: 'zed' });
		expect(loadPersonConfig({ HOME: dir })).toEqual({ dailyUsd: 25, assignee: 'zed' });
	});

	it('reads it from XDG_CONFIG_HOME when that is set', () => {
		write(join(dir, 'xdg'), { dailyUsd: 10 });
		expect(loadPersonConfig({ HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg') })).toEqual({
			dailyUsd: 10
		});
	});

	it('refuses a field that is wrong or unknown, naming the file and the field', () => {
		write(join(dir, '.config'), { dailyUsd: -5, asignee: 'zed' });
		const path = join(dir, '.config', 'nightjar', 'config.json');
		let fault: unknown;
		try {
			loadPersonConfig({ HOME: dir });
		} catch (caught) {
			fault = caught;
		}
		expect(fault).toBeInstanceOf(ConfigError);
		const message = (fault as Error).message;
		expect(message).toContain(`${path}: dailyUsd: `);
		expect(message).toContain(`${path}: Unrecognized key: "asignee"`);
	});

	it('refuses a file that is not JSON', () => {
		mkdirSync(join(dir, '.config', 'nightjar'), { recursive: true });
		writeFileSync(join(dir, '.config', 'nightjar', 'config.json'), '{ dailyUsd: 5');
		expect(() => loadPersonConfig({ HOME: dir })).toThrow(/config\.json is not JSON/);
	});
});
