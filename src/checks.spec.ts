// Single checks, each run in-process on the facts it needs; doctor.spec.ts runs them all on a machine.
import { describe, expect, it } from 'vitest';
import type { Adapters } from './adapters.js';
import { runChecks } from './check-runner.js';
import { apiKeyCheck, codeHostCheck, trackerCheck, type CheckOptions } from './checks.js';

const options = (over: Partial<CheckOptions> = {}): CheckOptions => ({
	useApiKey: false,
	env: {},
	cwd: '/nowhere',
	failFast: false,
	...over
});

// Adapters whose Tracker and Code host fail as `fault` says, each fixed with its own hint.
function adapters(fault: string | null): Adapters {
	const reach = () => (fault === null ? Promise.resolve() : Promise.reject(new Error(fault)));
	const tracker = { me: () => reach().then(() => 'ann') };
	return {
		tracker,
		repo: 'o/app',
		checked: (person: string) => `the board as ${person}`,
		trackerFix: (m: string) => `${m} Sign in to the board.`,
		reachCodeHost: reach,
		codeHostFix: (m: string) => `${m} Sign in to the host.`
	} as unknown as Adapters;
}

describe('the API key check', () => {
	it('refuses a set key the person did not choose', async () => {
		const { lines } = await runChecks(
			[apiKeyCheck],
			options({ env: { ANTHROPIC_API_KEY: 'sk-test' } }),
			false
		);
		expect(lines[0]?.status).toBe('fail');
		expect(lines[0]?.detail).toMatch(/pass --use-api-key/);
	});

	it('names the key when it is chosen', async () => {
		const { lines } = await runChecks(
			[apiKeyCheck],
			options({ useApiKey: true, env: { ANTHROPIC_API_KEY: 'sk-test' } }),
			false
		);
		expect(lines).toEqual([
			{
				name: 'API key',
				status: 'ok',
				detail: 'ANTHROPIC_API_KEY chosen',
				summary: 'ANTHROPIC_API_KEY chosen'
			}
		]);
	});
});

describe('the Tracker check', () => {
	it('names the person it reached the Tracker as', async () => {
		const { lines, found } = await runChecks([trackerCheck], options(), false, {
			adapters: adapters(null)
		});
		expect(lines[0]?.detail).toBe('the board as ann');
		expect(found.me).toBe('ann');
	});

	it("says the Tracker's own fix when it cannot be reached", async () => {
		const { lines, found } = await runChecks([trackerCheck], options(), false, {
			adapters: adapters('the board is down.')
		});
		expect(lines[0]).toMatchObject({
			status: 'fail',
			detail: 'the board is down. Sign in to the board.'
		});
		expect(found.me).toBeUndefined();
	});

	it('says nothing when there are no adapters to reach it by', async () => {
		const { lines } = await runChecks([trackerCheck], options(), false);
		expect(lines).toEqual([]);
	});
});

describe('the Code host check', () => {
	it('names the repo, and leaves it out of the summary', async () => {
		const { lines } = await runChecks([codeHostCheck], options(), false, {
			adapters: adapters(null)
		});
		expect(lines).toEqual([{ name: 'Code host', status: 'ok', detail: 'o/app', summary: null }]);
	});

	it("says the Code host's own fix when it cannot be reached", async () => {
		const { lines } = await runChecks([codeHostCheck], options(), false, {
			adapters: adapters('the host is down.')
		});
		expect(lines[0]?.detail).toBe('the host is down. Sign in to the host.');
	});

	it('is skipped without a usable factory.json', async () => {
		const { lines } = await runChecks([codeHostCheck], options(), false);
		expect(lines).toEqual([
			{ name: 'Code host', status: 'skip', detail: 'needs a usable factory.json', summary: null }
		]);
	});
});
