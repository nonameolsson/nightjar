import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { memoryWorktrees } from './fakes/worktree.js';
import {
	branchFor,
	openWorktree,
	worktreesFor,
	type OpenWorktree,
	type Worktree
} from './worktree.js';

describe('worktreesFor', () => {
	it('keeps the worktrees in a Nightjar folder in the home directory, one per checkout', () => {
		const one = worktreesFor('/home/ann', '/work/app');
		const other = worktreesFor('/home/ann', '/elsewhere/app');
		expect(one).toMatch(/^\/home\/ann\/\.nightjar\/worktrees\/app-[0-9a-f]{8}$/);
		expect(other).toMatch(/^\/home\/ann\/\.nightjar\/worktrees\/app-[0-9a-f]{8}$/);
		expect(one).not.toBe(other);
		expect(worktreesFor('/home/ann', '/work/app')).toBe(one);
	});
});

describe('branchFor', () => {
	it('names the branch by the Feature and a short slug of its title', () => {
		expect(branchFor('12', 'Add a "dark" mode — at last!')).toBe(
			'factory/12-add-a-dark-mode-at-last'
		);
		expect(branchFor('7', '???')).toBe('factory/7');
	});

	it('keeps a key such as PROJ-123 as it is, and turns what a branch name cannot hold into a dash', () => {
		expect(branchFor('PROJ-123', 'Escape')).toBe('factory/PROJ-123-escape');
		expect(branchFor('team/a b:1', 'Escape')).toBe('factory/team-a-b-1-escape');
	});
});

// What the contract needs of an adapter beyond the seam: a way to play the Session that leaves files.
interface Harness {
	readonly open: OpenWorktree;
	readonly worktrees: string;
	write(tree: Worktree, file: string): void;
	has(tree: Worktree, file: string): boolean;
	// the files written and not committed
	left(tree: Worktree): string[];
	// the first lines of the branch's own commits, newest first
	subjects(tree: Worktree): string[];
	// the files a side branch keeps
	kept(tree: Worktree, side: string): string[];
	// a person's own commit of one file on the branch, with no trailer
	personCommit(tree: Worktree, file: string): void;
}

// The real adapter runs real git over a repo made once for the file, and each test takes a branch of its own.
let repo: string;
let env: Record<string, string | undefined>;
const sh = (...args: string[]) =>
	execFileSync('git', args, { env, encoding: 'utf8', stdio: 'pipe' }).trim();

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), 'nightjar-worktree-'));
	const config = join(repo, 'gitconfig');
	// git starts gc and maintenance detached, and they can still be writing when the folder is removed
	writeFileSync(config, '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
	env = {
		...process.env,
		GIT_CONFIG_GLOBAL: config,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_AUTHOR_NAME: 'Test',
		GIT_AUTHOR_EMAIL: 'test@example.com',
		GIT_COMMITTER_NAME: 'Test',
		GIT_COMMITTER_EMAIL: 'test@example.com'
	};
	sh('init', '-q', '--bare', '-b', 'main', join(repo, 'origin.git'));
	sh('clone', '-q', join(repo, 'origin.git'), join(repo, 'app'));
	writeFileSync(join(repo, 'app', 'README.md'), 'hello\n');
	sh('-C', join(repo, 'app'), 'add', '.');
	sh('-C', join(repo, 'app'), 'commit', '-q', '-m', 'first');
	sh('-C', join(repo, 'app'), 'push', '-q', 'origin', 'main');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

vi.setConfig({ testTimeout: 30_000 });

const inTree = (tree: Worktree, ...args: string[]) => sh('-C', tree.at.folder, ...args);

const lines = (text: string) => text.split('\n').filter(Boolean);

function gitHarness(): Harness {
	const worktrees = join(repo, 'worktrees');
	return {
		worktrees,
		open: (_root, folders, branch, baseBranch) =>
			openWorktree(join(repo, 'app'), folders, branch, baseBranch, env),
		write: (tree, file) => writeFileSync(join(tree.at.folder, file), 'work\n'),
		has: (tree, file) => existsSync(join(tree.at.folder, file)),
		left: (tree) => lines(inTree(tree, 'status', '--porcelain')).map((l) => l.slice(3)),
		subjects: (tree) => lines(inTree(tree, 'log', '--format=%s', `${tree.at.base}..HEAD`)),
		kept: (tree, side) => lines(inTree(tree, 'show', '--name-only', '--format=', side)),
		personCommit: (tree, file) => {
			writeFileSync(join(tree.at.folder, file), 'by hand\n');
			inTree(tree, 'add', '-A');
			inTree(tree, 'commit', '-q', '-m', 'By hand');
		}
	};
}

function memoryHarness(): Harness {
	const trees = memoryWorktrees();
	return {
		worktrees: '/memory/worktrees',
		open: trees.open,
		write: (tree, file) => trees.write(tree.at.folder, file),
		has: (tree, file) => trees.has(tree.at.folder, file),
		left: (tree) => trees.left(tree.at.folder),
		subjects: (tree) => trees.subjects(tree.at.folder),
		kept: (_tree, side) => trees.sides.get(side) ?? [],
		personCommit: (tree, file) => trees.commitAsPerson(tree.at.folder, 'By hand', file)
	};
}

const adapters: [string, () => Harness][] = [
	['git', gitHarness],
	['in-memory', memoryHarness]
];

describe.each(adapters)('the %s worktree', (_name, make) => {
	let n = 0;
	// a Feature's worktree on a branch of its own
	const fresh = async () => {
		const world = make();
		const branch = `factory/${String((n += 1))}-feature`;
		const tree = await world.open('/unused', world.worktrees, branch, 'main', {});
		return { world, branch, tree };
	};

	it('opens on the base with nothing built, set up, or left', async () => {
		const { world, tree } = await fresh();
		expect(tree.at).toMatchObject({ base: 'origin/main' });
		expect(await tree.ahead()).toBe(0);
		expect(await tree.built()).toEqual(new Set());
		expect(await tree.stepsDone()).toEqual(new Set());
		expect(await tree.isSetUp()).toBe(false);
		expect(world.left(tree)).toEqual([]);
	});

	it('commits what a session left, naming the Ticket, and says when it left nothing', async () => {
		const { world, tree } = await fresh();
		expect(await tree.commitTicket('2', 'Share it', 'Done.', 's1')).toBe(false);

		world.write(tree, 'a.txt');
		expect(await tree.commitTicket('2', 'Share it', 'Done.', 's1')).toBe(true);
		expect(world.subjects(tree)).toEqual(['Share it (#2)']);
		expect(await tree.built()).toEqual(new Set(['2']));
		expect(await tree.ahead()).toBe(1);
		expect(world.left(tree)).toEqual([]);
		expect(world.has(tree, 'a.txt')).toBe(true);
	});

	it('commits what a Step left under its key, and says when it left nothing', async () => {
		const { world, tree } = await fresh();
		const step = {
			workflow: 'w',
			step: 'lint',
			key: 'w/lint',
			after: '2',
			summary: 'ok',
			session: 's'
		};
		expect(await tree.commitStep(step)).toBe(false);

		world.write(tree, 'lint.txt');
		expect(await tree.commitStep(step)).toBe(true);
		expect(world.subjects(tree)).toEqual(['w: lint (after #2)']);
		expect(await tree.stepsDone()).toEqual(new Set(['w/lint']));
		expect(await tree.built()).toEqual(new Set());
	});

	it('discards what a session left onto a side branch, and leaves the worktree clean', async () => {
		const { world, branch, tree } = await fresh();
		const before = await tree.head();
		world.write(tree, 'a.txt');

		expect(await tree.discard(before, '2')).toBe(`${branch}-attempt-2`);
		expect(world.has(tree, 'a.txt')).toBe(false);
		expect(world.left(tree)).toEqual([]);
		expect(await tree.head()).toBe(before);
		expect(world.kept(tree, `${branch}-attempt-2`)).toEqual(['a.txt']);
	});

	it('discards a commit the session made as well, so the Ticket is not built', async () => {
		const { world, tree } = await fresh();
		const before = await tree.head();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		world.write(tree, 'b.txt');

		expect(await tree.discard(before, '2')).not.toBeNull();
		expect(await tree.built()).toEqual(new Set());
		expect(await tree.ahead()).toBe(0);
		expect(world.has(tree, 'a.txt')).toBe(false);
		expect(world.has(tree, 'b.txt')).toBe(false);
	});

	it('discards nothing, and keeps no branch, when the session left nothing', async () => {
		const { tree } = await fresh();
		expect(await tree.discard(await tree.head(), '2')).toBeNull();
	});

	it('reverts a Step to where it was, keeping nothing of it', async () => {
		const { world, tree } = await fresh();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		const before = await tree.head();
		world.write(tree, 'lint.txt');
		await tree.commitStep({
			workflow: 'w',
			step: 'lint',
			key: 'w/lint',
			after: null,
			summary: '',
			session: 's'
		});
		world.write(tree, 'more.txt');

		await tree.revert(before);
		expect(await tree.head()).toBe(before);
		expect(await tree.stepsDone()).toEqual(new Set());
		expect(await tree.built()).toEqual(new Set(['2']));
		expect(world.has(tree, 'lint.txt')).toBe(false);
		expect(world.left(tree)).toEqual([]);
	});

	it('goes on in the worktree a stopped run left: its commits and setup kept, its dirt cleaned', async () => {
		const { world, branch, tree } = await fresh();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		await tree.markSetUp();
		world.write(tree, 'half-done.txt');

		const again = await world.open('/unused', world.worktrees, branch, 'main', {});
		expect(again.at).toEqual(tree.at);
		expect(await again.built()).toEqual(new Set(['2']));
		expect(await again.isSetUp()).toBe(true);
		expect(world.has(again, 'half-done.txt')).toBe(false);
		expect(world.left(again)).toEqual([]);
	});

	it("reads the Feature's diff, and cuts it at the limit", async () => {
		const { world, tree } = await fresh();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');

		const whole = await tree.diff(10_000);
		expect(whole.truncated).toBe(false);
		expect(whole.text).toContain('+++ b/a.txt');
		expect(await tree.diff(10)).toEqual({ text: whole.text.slice(0, 10), truncated: true });
	});

	it('commits a Pull-check fix as a new commit with its round, and counts the fixes on the branch', async () => {
		const { world, tree } = await fresh();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		expect(await tree.pullFixes()).toBe(0);
		expect(await tree.commitPullFix(1, 'Pinned the Node version.', 's1')).toBe(false);

		world.write(tree, 'ci.txt');
		expect(await tree.commitPullFix(1, 'Pinned the Node version.', 's1')).toBe(true);
		expect(world.subjects(tree)).toEqual(['Fix the Pull checks, round 1', 'Share it (#2)']);
		expect(await tree.pullFixes()).toBe(1);
		expect(await tree.built()).toEqual(new Set(['2']));
		world.write(tree, 'ci2.txt');
		await tree.commitPullFix(2, 'Again.', 's1');
		expect(await tree.pullFixes()).toBe(2);
		expect(Object.fromEntries(await tree.headTrailers())).toEqual({
			'Factory-Pull-Fix': '2',
			'Factory-Session': 's1'
		});
	});

	it("reads the head commit's trailers, and none from a person's own commit", async () => {
		const { world, tree } = await fresh();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		expect(Object.fromEntries(await tree.headTrailers())).toEqual({
			'Factory-Ticket': '#2',
			'Factory-Session': 's1'
		});

		world.personCommit(tree, 'mine.txt');
		expect(await tree.headTrailers()).toEqual(new Map());
	});
});

describe('the git worktree against its remote', () => {
	let n = 0;
	const open = (branch: string) =>
		openWorktree(join(repo, 'app'), join(repo, 'remote-worktrees'), branch, 'main', env);
	const pushed = async () => {
		const branch = `factory/r${String((n += 1))}-feature`;
		const tree = await open(branch);
		writeFileSync(join(tree.at.folder, 'a.txt'), 'work\n');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		inTree(tree, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
		return { branch, tree };
	};

	it('says so when the remote has no such branch', async () => {
		expect(await (await open('factory/nowhere')).toRemote()).toBe(false);
	});

	it('stays where it is when it is at the remote', async () => {
		const { tree } = await pushed();
		const head = await tree.head();
		expect(await tree.toRemote()).toBe(true);
		expect(await tree.head()).toBe(head);
	});

	it("moves on to a commit pushed from elsewhere, so the head is the remote's", async () => {
		const { branch } = await pushed();
		// another clone pushes on top
		const other = join(repo, `other-${String(n)}`);
		sh('clone', '-q', '-b', branch, join(repo, 'origin.git'), other);
		writeFileSync(join(other, 'mine.txt'), 'by hand\n');
		sh('-C', other, 'add', '-A');
		sh('-C', other, 'commit', '-q', '-m', 'By hand');
		sh('-C', other, 'push', '-q', 'origin', branch);

		const again = await open(branch);
		expect(await again.toRemote()).toBe(true);
		expect(await again.head()).toBe(sh('-C', other, 'rev-parse', 'HEAD'));
		expect(await again.headTrailers()).toEqual(new Map());
	});

	it('keeps commits the remote lacks, and says so', async () => {
		const { tree } = await pushed();
		writeFileSync(join(tree.at.folder, 'b.txt'), 'work\n');
		await tree.commitTicket('3', 'Use it', 'Done.', 's2');
		const head = await tree.head();
		expect(await tree.toRemote()).toBe(false);
		expect(await tree.head()).toBe(head);
	});
});
