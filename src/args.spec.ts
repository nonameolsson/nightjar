import { describe, expect, it } from 'vitest';
import { apiKeyProblem, parseArgs, platformProblem } from './args.js';
import { repoFromRemote } from './github/api.js';

describe('parseArgs', () => {
	it('reads each mode and the flags', () => {
		expect(parseArgs(['--watch'])).toEqual({ mode: 'watch', useApiKey: false });
		expect(parseArgs(['--once'])).toEqual({ mode: 'once', useApiKey: false });
		expect(parseArgs(['doctor'])).toEqual({ mode: 'doctor', useApiKey: false });
		expect(parseArgs(['doctor', '--use-api-key'])).toEqual({ mode: 'doctor', useApiKey: true });
		// --dry-run is the old name of doctor
		expect(parseArgs(['--dry-run'])).toEqual({ mode: 'doctor', useApiKey: false });
		// doctor with a Feature checks that Feature, whichever is said first
		expect(parseArgs(['doctor', '#42'])).toEqual({
			mode: 'doctor',
			feature: '42',
			useApiKey: false
		});
		expect(parseArgs(['42', '--dry-run'])).toEqual({
			mode: 'doctor',
			feature: '42',
			useApiKey: false
		});
		expect(parseArgs(['#42', '--model', 'opus', '--effort', 'high', '--use-api-key'])).toEqual({
			mode: 'feature',
			feature: '42',
			useApiKey: true,
			model: 'opus',
			effort: 'high'
		});
		expect(parseArgs(['7'])).toEqual({ mode: 'feature', feature: '7', useApiKey: false });
		// a Tracker module's own keys, as Jira or Linear spell them
		expect(parseArgs(['PROJ-123'])).toEqual({
			mode: 'feature',
			feature: 'PROJ-123',
			useApiKey: false
		});
	});

	it('reads --poll with --watch, and refuses it elsewhere or under 30', () => {
		expect(parseArgs(['--watch', '--poll', '45'])).toEqual({
			mode: 'watch',
			useApiKey: false,
			poll: 45
		});
		expect(parseArgs(['--poll', '30', '--watch'])).toMatchObject({ poll: 30 });
		expect(parseArgs(['--watch', '--poll', '29'])).toMatch(/at least 30/);
		expect(parseArgs(['--watch', '--poll', 'soon'])).toMatch(/at least 30/);
		expect(parseArgs(['--watch', '--poll'])).toBe('--poll needs a value');
		expect(parseArgs(['--once', '--poll', '60'])).toBe('--poll goes with --watch only');
		expect(parseArgs(['--poll', '60'])).toBe('say what to build');
	});

	it('reads retro, with --create and the flags a Session takes, and nothing that builds', () => {
		expect(parseArgs(['retro'])).toEqual({ mode: 'retro', useApiKey: false });
		expect(parseArgs(['retro', '--create', '--model', 'opus', '--profile', 'work'])).toEqual({
			mode: 'retro',
			useApiKey: false,
			create: true,
			model: 'opus',
			profile: 'work'
		});
		const alone = 'retro goes alone, with no --watch, --once, Feature or doctor';
		expect(parseArgs(['retro', '--once'])).toBe(alone);
		expect(parseArgs(['retro', '42'])).toBe(alone);
		expect(parseArgs(['doctor', 'retro'])).toBe(alone);
		expect(parseArgs(['retro', '--poll', '60'])).toBe('--poll goes with --watch only');
		expect(parseArgs(['--once', '--create'])).toBe('--create goes with retro only');
	});

	it('reads --parallel with --watch or --once, and refuses it elsewhere or out of range', () => {
		expect(parseArgs(['--watch', '--parallel', '3'])).toMatchObject({ mode: 'watch', parallel: 3 });
		expect(parseArgs(['--parallel', '8', '--once'])).toMatchObject({ mode: 'once', parallel: 8 });
		expect(parseArgs(['--watch'])).not.toHaveProperty('parallel');
		const only = '--parallel goes with --watch and --once only';
		expect(parseArgs(['42', '--parallel', '2'])).toBe(only);
		expect(parseArgs(['doctor', '--parallel', '2'])).toBe(only);
		expect(parseArgs(['doctor', '42', '--parallel', '2'])).toBe(only);
		for (const bad of ['0', '9', '1.5', 'many'])
			expect(parseArgs(['--watch', '--parallel', bad])).toMatch(/from 1 to 8/);
		expect(parseArgs(['--watch', '--parallel'])).toBe('--parallel needs a value');
	});

	it('reads --profile with its name', () => {
		expect(parseArgs(['--once', '--profile', 'work'])).toEqual({
			mode: 'once',
			useApiKey: false,
			profile: 'work'
		});
		expect(parseArgs(['--once', '--profile'])).toBe('--profile needs a value');
	});

	it('names what is wrong', () => {
		expect(parseArgs([])).toBe('say what to build');
		expect(parseArgs(['--watch', '--once'])).toBe(
			'choose one of --watch, --once, a Feature and doctor'
		);
		expect(parseArgs(['doctor', '--once'])).toBe(
			'choose one of --watch, --once, a Feature and doctor'
		);
		expect(parseArgs(['1', '2'])).toBe('choose one of --watch, --once, a Feature and doctor');
		expect(parseArgs(['--model'])).toBe('--model needs a value');
		expect(parseArgs(['--effort', '--once'])).toBe('--effort needs a value');
		expect(parseArgs(['--detach'])).toBe('unknown argument --detach');
	});
});

describe('repoFromRemote', () => {
	it('reads owner and name from an ssh or https origin', () => {
		expect(repoFromRemote('git@github.com:someone/app.git')).toBe('someone/app');
		expect(repoFromRemote('https://github.com/someone/app\n')).toBe('someone/app');
		expect(repoFromRemote('https://dev.azure.com/o/p/_git/r')).toBeNull();
	});
});

describe('apiKeyProblem', () => {
	it('refuses a key in the shell unless the person chose it', () => {
		expect(apiKeyProblem({ ANTHROPIC_API_KEY: 'sk' }, false)).toMatch(/Unset it/);
		expect(apiKeyProblem({ ANTHROPIC_API_KEY: 'sk' }, true)).toBeNull();
		expect(apiKeyProblem({}, false)).toBeNull();
	});
});

describe('platformProblem', () => {
	it('stops native Windows, and lets macOS, Linux and WSL2 (which reports linux) through', () => {
		expect(platformProblem('win32')).toBe(
			'native Windows is not supported; Nightjar runs on macOS, Linux and WSL2.'
		);
		expect(platformProblem('darwin')).toBeNull();
		expect(platformProblem('linux')).toBeNull();
	});
});
