import type { EngineInterface } from 'claude-code';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Status } from '../../../src/status-shape.js';

const building = {
	kind: 'building',
	feature: '5',
	ticket: '7',
	step: 'build',
	round: 1,
	rounds: 2,
	session: 's',
	startedAt: new Date().toISOString()
} as const;

const status = (doing: Status['doing'], over: Partial<Status> = {}): Status => ({
	at: new Date().toISOString(),
	pid: 4242,
	spentTodayUsd: 0,
	dailyUsd: 60,
	doing,
	recent: [],
	codeMoved: null,
	...over
});

// A fake engine: git answers with `gitDir`, the status file holds `file`, `kill -0` succeeds when `alive`.
function engine(o: { gitDir?: string; file?: Status; alive?: boolean }) {
	const ran: string[][] = [];
	const statuses: (string | undefined)[] = [];
	const toasts: string[] = [];
	const ticks: (() => void)[] = [];
	let file = o.file;
	const $: EngineInterface = {
		process: {
			run: (argv) => {
				ran.push(argv);
				if (argv[0] === 'git') {
					return Promise.resolve(
						o.gitDir === undefined
							? { exitCode: 128, stdout: '' }
							: { exitCode: 0, stdout: `${o.gitDir}\n` }
					);
				}
				return Promise.resolve({ exitCode: o.alive === false ? 1 : 0, stdout: '' });
			}
		},
		fs: {
			exists: (path) =>
				Promise.resolve(file !== undefined && path.endsWith('/.factory/status.json')),
			read: () => Promise.resolve(JSON.stringify(file))
		},
		ui: { status: (text) => statuses.push(text), toast: (text) => toasts.push(text) },
		clock: { now: () => Promise.resolve(Date.now()), every: (_ms, fn) => ticks.push(fn) }
	};
	return {
		$,
		ran,
		statuses,
		toasts,
		ticks,
		set: (next: Status | undefined) => {
			file = next;
		}
	};
}

// `seen` lives in the module, so each spec loads a fresh one
async function start(e: ReturnType<typeof engine>) {
	const { register } = await import('./register.js');
	let hook: ((...a: never[]) => Promise<unknown>) | undefined;
	register((_event, h) => {
		hook = h;
	});
	await (hook as unknown as (...a: unknown[]) => Promise<unknown>)(e.$, {}, () =>
		Promise.resolve('done')
	);
}

beforeEach(() => vi.resetModules());

describe('the status plugin', () => {
	it('reads the file from the main checkout, found through the git common dir', async () => {
		const e = engine({ gitDir: '/main/checkout/.git', file: status(building) });
		await start(e);
		expect(e.ran[0]).toEqual(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']);
		expect(e.statuses.at(-1)).toContain('nightjar: #5 › #7 build');
	});

	it('does nothing outside a git checkout', async () => {
		const e = engine({ file: status(building) });
		await start(e);
		expect(e.statuses).toEqual([]);
		expect(e.ticks).toEqual([]);
	});

	it('shows nothing when no file exists, or Nightjar is off', async () => {
		const none = engine({ gitDir: '/r/.git' });
		await start(none);
		expect(none.statuses).toEqual([undefined]);
		const off = engine({ gitDir: '/r/.git', file: status({ kind: 'off' }) });
		await start(off);
		expect(off.statuses).toEqual([undefined]);
	});

	it('says stopped when the pid is dead while the file still names a step', async () => {
		const e = engine({ gitDir: '/r/.git', file: status(building), alive: false });
		await start(e);
		expect(e.ran).toContainEqual(['kill', '-0', '4242']);
		expect(e.statuses.at(-1)).toBe('nightjar: stopped without writing off');
	});

	it('does not call a dead pid stopped once the file says off', async () => {
		const e = engine({ gitDir: '/r/.git', file: status({ kind: 'off' }), alive: false });
		await start(e);
		expect(e.statuses).toEqual([undefined]);
	});

	it('toasts each new event once, and none already there at the start', async () => {
		const at = new Date().toISOString();
		const built = { kind: 'built', feature: '5', ticket: '6', at } as const;
		const e = engine({
			gitDir: '/r/.git',
			file: status(building, { recent: [{ ...built, seq: 1 }] })
		});
		await start(e);
		expect(e.toasts).toEqual([]);
		e.set(
			status(building, {
				recent: [
					{ ...built, seq: 1 },
					{ ...built, ticket: '7', seq: 2 }
				]
			})
		);
		e.ticks[0]?.();
		await vi.waitFor(() => expect(e.toasts).toEqual(['nightjar: #7 built (#5)']));
		e.ticks[0]?.();
		await new Promise((r) => setTimeout(r, 10));
		expect(e.toasts).toHaveLength(1);
	});
});
