import { describe, expect, it } from 'vitest';
import type { Run } from './git.js';
import { startStale, type StaleSeams } from './stale.js';

const ok = (out: string): Run => ({ ok: true, out, err: '', missing: false });
const bad: Run = { ok: false, out: '', err: 'offline', missing: false };

// A package directory whose installed version and git answers a spec scripts.
function world(o: { linked: boolean; answers?: Record<string, Run> }) {
	const installed = { version: '0.2.0' };
	const answers = o.answers ?? {};
	const calls: string[] = [];
	const seams: StaleSeams = {
		packageDir: '/pkg',
		env: {},
		isCheckout: () => o.linked,
		installedVersion: () => installed.version,
		run: (command, args) => {
			const key = `${command} ${args.join(' ')}`;
			calls.push(key);
			return Promise.resolve(answers[key] ?? bad);
		}
	};
	return { seams, calls, answers, installed };
}

describe('startStale from an installed Nightjar', () => {
	it('is null while the installed and published versions are the one that started', async () => {
		const w = world({ linked: false });
		w.answers['npm view @nonameolsson/nightjar version'] = ok('0.2.0\n');
		expect(await (await startStale(w.seams))()).toBeNull();
	});

	it('names an installed version newer than the one that started', async () => {
		const w = world({ linked: false });
		const check = await startStale(w.seams);
		w.installed.version = '0.2.1';
		expect(await check()).toBe('0.2.1');
	});

	it('names a published version newer than the one that started', async () => {
		const w = world({ linked: false });
		w.answers['npm view @nonameolsson/nightjar version'] = ok('0.3.0\n');
		expect(await (await startStale(w.seams))()).toBe('0.3.0');
	});

	it('does not call a lower published version newer', async () => {
		const w = world({ linked: false });
		w.answers['npm view @nonameolsson/nightjar version'] = ok('0.1.9\n');
		expect(await (await startStale(w.seams))()).toBeNull();
	});

	it('is null, not a fault, when the registry cannot be reached', async () => {
		const w = world({ linked: false });
		expect(await (await startStale(w.seams))()).toBeNull();
	});
});

describe('a call that hangs', () => {
	it('gives up and says nothing newer, so a watch is never stalled', async () => {
		const w = world({ linked: false });
		const hung: StaleSeams = {
			...w.seams,
			timeoutMs: 10,
			run: () => new Promise<Run>(() => undefined)
		};
		expect(await (await startStale(hung))()).toBeNull();
	});
});

describe('startStale from a linked checkout', () => {
	const rev = 'git rev-parse HEAD';
	it('names origin/main when it is ahead of the commit that started', async () => {
		const w = world({ linked: true });
		w.answers[rev] = ok('aaa111\n');
		const check = await startStale(w.seams);
		w.answers['git fetch --quiet origin main'] = ok('');
		w.answers['git rev-parse origin/main'] = ok('bbb222\n');
		w.answers['git merge-base --is-ancestor aaa111 bbb222'] = ok('');
		expect(await check()).toBe('bbb222');
	});

	it('is null when origin/main is the commit that started', async () => {
		const w = world({ linked: true });
		w.answers[rev] = ok('aaa111\n');
		const check = await startStale(w.seams);
		w.answers['git fetch --quiet origin main'] = ok('');
		w.answers['git rev-parse origin/main'] = ok('aaa111\n');
		expect(await check()).toBeNull();
	});

	it('is null when the checkout is ahead of origin/main', async () => {
		const w = world({ linked: true });
		w.answers[rev] = ok('aaa111\n');
		const check = await startStale(w.seams);
		w.answers['git fetch --quiet origin main'] = ok('');
		w.answers['git rev-parse origin/main'] = ok('bbb222\n');
		w.answers['git merge-base --is-ancestor aaa111 bbb222'] = { ...bad };
		expect(await check()).toBeNull();
	});

	it('is null, not a fault, when the fetch fails', async () => {
		const w = world({ linked: true });
		w.answers[rev] = ok('aaa111\n');
		const check = await startStale(w.seams);
		expect(await check()).toBeNull();
	});

	it('does not look at npm', async () => {
		const w = world({ linked: true });
		w.answers[rev] = ok('aaa111\n');
		await (
			await startStale(w.seams)
		)();
		expect(w.calls.some((c) => c.startsWith('npm'))).toBe(false);
	});
});
