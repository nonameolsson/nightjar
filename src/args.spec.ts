import { describe, expect, it } from 'vitest';
import { apiKeyProblem, parseArgs } from './args.js';
import { repoFromRemote } from './github/api.js';

describe('parseArgs', () => {
	it('reads each mode and the flags', () => {
		expect(parseArgs(['--watch'])).toEqual({ mode: 'watch', useApiKey: false });
		expect(parseArgs(['--once'])).toEqual({ mode: 'once', useApiKey: false });
		expect(parseArgs(['--dry-run'])).toEqual({ mode: 'dry-run', useApiKey: false });
		expect(parseArgs(['#42', '--model', 'opus', '--effort', 'high', '--use-api-key'])).toEqual({
			mode: 'feature',
			feature: 42,
			useApiKey: true,
			model: 'opus',
			effort: 'high'
		});
		expect(parseArgs(['7'])).toEqual({ mode: 'feature', feature: 7, useApiKey: false });
	});

	it('names what is wrong', () => {
		expect(parseArgs([])).toBe('say what to build');
		expect(parseArgs(['--watch', '--once'])).toBe(
			'choose one of --watch, --once, a Feature and --dry-run'
		);
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
