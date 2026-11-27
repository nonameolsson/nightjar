import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
	// a commit of one file on a base branch, made on the first; a Feature's branch holds it only once it is merged in, and a reopened worktree sees it
	moveBase(baseBranch: string, file: string, text: string): void;
}

// The real adapter runs real git over a repo made once for the file, and each test takes a branch of its own.
let repo: string;
let env: Record<string, string | undefined>;
let bases = 0;
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
		},
		moveBase: (baseBranch, file, text) => {
			const exists = sh('ls-remote', '--heads', join(repo, 'origin.git'), baseBranch) !== '';
			const clone = join(repo, `base-${String((bases += 1))}`);
			sh('clone', '-q', '-b', exists ? baseBranch : 'main', join(repo, 'origin.git'), clone);
			if (!exists) sh('-C', clone, 'checkout', '-q', '-b', baseBranch);
			writeFileSync(join(clone, file), text);
			sh('-C', clone, 'add', '-A');
			sh('-C', clone, 'commit', '-q', '-m', `The base writes ${file}`);
			sh('-C', clone, 'push', '-q', 'origin', baseBranch);
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
		personCommit: (tree, file) => trees.commitAsPerson(tree.at.folder, 'By hand', file),
		moveBase: (baseBranch, file, text) => {
			trees.moveBase(baseBranch, file, text);
		}
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

	it('reads a file of the worktree, and says none when it has none', async () => {
		const { world, tree } = await fresh();
		world.write(tree, 'x.md');
		expect(await tree.read('x.md')).toBe('work\n');
		expect(await tree.read('none.md')).toBeNull();
	});

	it.runIf(_name === 'git')(
		'reads no file that a symlink or a directory puts out of reach',
		async () => {
			const { tree } = await fresh();
			const outside = mkdtempSync(join(tmpdir(), 'outside-'));
			writeFileSync(join(outside, 'secret.md'), 'secret\n');
			symlinkSync(join(outside, 'secret.md'), join(tree.at.folder, 'link.md'));
			symlinkSync(outside, join(tree.at.folder, 'dir'));
			expect(await tree.read('link.md')).toBeNull();
			expect(await tree.read('dir/secret.md')).toBeNull();
			expect(await tree.read('.')).toBeNull();
			rmSync(outside, { recursive: true, force: true });
		}
	);

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

	it('restores a snapshot of the uncommitted work, losing the file a failed try left after it', async () => {
		const { world, tree } = await fresh();
		world.write(tree, 'built.txt');
		const mark = await tree.snapshot();
		world.write(tree, 'junk.txt');

		await tree.restore(mark);
		expect(world.has(tree, 'junk.txt')).toBe(false);
		expect(world.has(tree, 'built.txt')).toBe(true);
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

	it('counts the Pull-check fixes again in a later run, from the trailers alone', async () => {
		const { world, branch, tree } = await fresh();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		world.write(tree, 'ci.txt');
		await tree.commitPullFix(1, 'Pinned the Node version.', 's1');
		world.write(tree, 'ci2.txt');
		await tree.commitPullFix(2, 'Set TZ.', 's1');

		const again = await world.open('/unused', world.worktrees, branch, 'main', {});
		expect(await again.pullFixes()).toBe(2);
		expect((await again.headTrailers()).get('Factory-Pull-Fix')).toBe('2');
	});

	it('commits a Feedback round naming the feedback it answered, and reads every answered id again in a later run', async () => {
		const { world, branch, tree } = await fresh();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		expect(await tree.answeredFeedback()).toEqual(new Set());
		expect(await tree.commitFeedback(['comment:12'], 'Renamed it.', 's2')).toBeNull();

		world.write(tree, 'b.txt');
		const short = await tree.commitFeedback(['comment:12', 'review:4'], 'Renamed it.', 's2');
		expect(short).toMatch(/^[0-9a-f]{7,}$/);
		expect(world.subjects(tree)).toEqual(['Answer feedback on the pull request', 'Share it (#2)']);
		expect(Object.fromEntries(await tree.headTrailers())).toEqual({
			'Factory-Feedback': 'comment:12, review:4',
			'Factory-Session': 's2'
		});
		world.write(tree, 'c.txt');
		await tree.commitFeedback(['check:7'], 'Fixed the test.', 's3');
		world.personCommit(tree, 'mine.txt');

		const again = await world.open('/unused', world.worktrees, branch, 'main', {});
		expect(await again.answeredFeedback()).toEqual(new Set(['comment:12', 'review:4', 'check:7']));
		expect(await again.built()).toEqual(new Set(['2']));
	});

	it('commits a Review round as its own commit, naming its round and its Session, and says when it changed no file', async () => {
		const { world, tree } = await fresh();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		expect(await tree.commitReview(1, 'Fixed the off-by-one.', 's4')).toBe(false);

		world.write(tree, 'b.txt');
		expect(await tree.commitReview(1, 'Fixed the off-by-one.', 's4')).toBe(true);
		expect(world.subjects(tree)).toEqual(['Answer the Review, round 1', 'Share it (#2)']);
		expect(Object.fromEntries(await tree.headTrailers())).toEqual({
			'Factory-Review': '1',
			'Factory-Session': 's4'
		});
		expect(await tree.built()).toEqual(new Set(['2']));
	});

	it('keeps a thrown-away Review round on the -attempt-review side branch', async () => {
		const { world, branch, tree } = await fresh();
		world.write(tree, 'a.txt');
		await tree.commitTicket('2', 'Share it', 'Done.', 's1');
		const before = await tree.head();
		world.write(tree, 'b.txt');

		expect(await tree.discard(before, 'review')).toBe(`${branch}-attempt-review`);
		expect(world.kept(tree, `${branch}-attempt-review`)).toEqual(['b.txt']);
		expect(await tree.built()).toEqual(new Set(['2']));
	});

	// A Feature that built Ticket #2 on `shared.txt`, on a base branch of its own; `reopen` takes the base as it is by then, as a run does that opens the worktree again.
	const forked = async () => {
		const world = make();
		n += 1;
		const base = `moving-${String(n)}`;
		const branch = `factory/${String(n)}-feature`;
		world.moveBase(base, 'seed.txt', 'seed\n');
		const reopen = () => world.open('/unused', world.worktrees, branch, base, {});
		const first = await reopen();
		world.write(first, 'shared.txt');
		await first.commitTicket('2', 'Share it', 'Done.', 's1');
		const moveBase = (file: string, text: string) => world.moveBase(base, file, text);
		return { world, branch, reopen, moveBase };
	};

	it('merges a base that wrote the same file differently, naming the conflicting file and not the others', async () => {
		const { world, reopen, moveBase } = await forked();
		moveBase('base.txt', 'from the base\n');
		moveBase('shared.txt', 'from the base\n');
		const tree = await reopen();

		expect(await tree.mergeBase()).toEqual({ kind: 'conflicts', files: ['shared.txt'] });
		expect(await tree.ahead()).toBe(1);
		expect(world.has(tree, 'base.txt')).toBe(true);
	});

	it('commits a resolved merge as one commit with its round and Session, and keeps every earlier commit', async () => {
		const { world, reopen, moveBase } = await forked();
		moveBase('base.txt', 'from the base\n');
		moveBase('shared.txt', 'from the base\n');
		const tree = await reopen();
		await tree.mergeBase();
		world.write(tree, 'shared.txt');

		expect(await tree.commitConflictFix(1, 'Kept both.', 's5')).toBe(true);
		expect(world.subjects(tree)).toEqual([
			`Merge ${tree.at.base} into the branch, conflict fix round 1`,
			'Share it (#2)'
		]);
		expect(Object.fromEntries(await tree.headTrailers())).toEqual({
			'Factory-Conflicts': '1',
			'Factory-Session': 's5'
		});
		expect(await tree.built()).toEqual(new Set(['2']));
		expect(await tree.conflictFixes()).toBe(1);
		expect(world.has(tree, 'base.txt')).toBe(true);
		expect(world.left(tree)).toEqual([]);
	});

	it('leaves a merge that completes ready to commit the same way', async () => {
		const { world, reopen, moveBase } = await forked();
		moveBase('base.txt', 'from the base\n');
		const tree = await reopen();

		expect(await tree.mergeBase()).toEqual({ kind: 'clean' });
		expect(await tree.commitConflictFix(1, 'Nothing to resolve.', 's5')).toBe(true);
		expect(world.subjects(tree)).toHaveLength(2);
		expect(await tree.conflictFixes()).toBe(1);
		expect(world.has(tree, 'base.txt')).toBe(true);
	});

	it('merges nothing, and commits nothing, when the branch already holds the base', async () => {
		const { world, reopen, moveBase } = await forked();
		const tree = await reopen();

		expect(await tree.mergeBase()).toEqual({ kind: 'clean' });
		expect(await tree.commitConflictFix(1, 'Nothing.', 's5')).toBe(false);
		expect(world.subjects(tree)).toEqual(['Share it (#2)']);

		moveBase('base.txt', 'from the base\n');
		const later = await reopen();
		await later.mergeBase();
		await later.commitConflictFix(1, 'Took it.', 's5');
		const merged = await reopen();
		expect(await merged.mergeBase()).toEqual({ kind: 'clean' });
		expect(await merged.commitConflictFix(2, 'Nothing.', 's5')).toBe(false);
	});

	it('commits no merge when none was begun', async () => {
		const { tree } = await fresh();
		expect(await tree.commitConflictFix(1, 'Nothing.', 's5')).toBe(false);
		expect(await tree.conflictFixes()).toBe(0);
	});

	it('counts the Conflict fixes again in a later run, from the trailers alone', async () => {
		const { reopen, moveBase } = await forked();
		for (const round of [1, 2]) {
			moveBase(`base${String(round)}.txt`, 'from the base\n');
			const tree = await reopen();
			expect(await tree.conflictFixes()).toBe(round - 1);
			await tree.mergeBase();
			await tree.commitConflictFix(round, 'Took it.', 's5');
		}

		const again = await reopen();
		expect(await again.conflictFixes()).toBe(2);
		expect((await again.headTrailers()).get('Factory-Conflicts')).toBe('2');
		expect(await again.built()).toEqual(new Set(['2']));
	});

	it('keeps a thrown-away Conflict fix on the -attempt-conflicts side branch, and the merge is gone', async () => {
		const { world, branch, reopen, moveBase } = await forked();
		moveBase('base.txt', 'from the base\n');
		moveBase('shared.txt', 'from the base\n');
		const tree = await reopen();
		const before = await tree.head();
		await tree.mergeBase();

		const side = `${branch}-attempt-conflicts`;
		expect(await tree.discard(before, 'conflicts')).toBe(side);
		expect(world.kept(tree, side).sort()).toEqual(['base.txt', 'shared.txt']);
		expect(await tree.head()).toBe(before);
		expect(world.left(tree)).toEqual([]);
		expect(world.has(tree, 'base.txt')).toBe(false);
		expect(await tree.commitConflictFix(1, 'Nothing.', 's5')).toBe(false);
		expect(await tree.mergeBase()).toEqual({ kind: 'conflicts', files: ['shared.txt'] });
	});

	it('keeps the merge pending when a fix round restores a snapshot of what the Session left', async () => {
		const { world, reopen, moveBase } = await forked();
		moveBase('shared.txt', 'from the base\n');
		const tree = await reopen();
		await tree.mergeBase();
		world.write(tree, 'shared.txt');
		const mark = await tree.snapshot();
		world.write(tree, 'junk.txt');
		await tree.restore(mark);

		expect(world.has(tree, 'junk.txt')).toBe(false);
		expect(await tree.commitConflictFix(1, 'Kept both.', 's5')).toBe(true);
		expect(await tree.mergeBase()).toEqual({ kind: 'clean' });
		expect(await tree.commitConflictFix(2, 'Nothing.', 's5')).toBe(false);
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

describe('the git worktree merging its base', () => {
	it('commits a true merge: the branch and the base are its two parents, and the base is never rebased onto', async () => {
		const world = gitHarness();
		world.moveBase('merging', 'seed.txt', 'seed\n');
		const open = () => world.open('/unused', world.worktrees, 'factory/merging', 'merging', {});
		const first = await open();
		world.write(first, 'a.txt');
		await first.commitTicket('2', 'Share it', 'Done.', 's1');
		const ticket = await first.head();
		world.moveBase('merging', 'b.txt', 'from the base\n');

		const tree = await open();
		await tree.mergeBase();
		expect(inTree(tree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).not.toBe('');
		await tree.commitConflictFix(1, 'Took it.', 's5');

		expect(inTree(tree, 'rev-parse', 'HEAD^1')).toBe(ticket);
		expect(inTree(tree, 'rev-parse', 'HEAD^2')).toBe(inTree(tree, 'rev-parse', tree.at.base));
		expect(inTree(tree, 'status', '--porcelain')).toBe('');
	});

	it('refuses a merge git itself refuses, rather than calling it a conflict', async () => {
		const world = gitHarness();
		const tree = await world.open('/unused', world.worktrees, 'factory/refused', 'main', {});
		inTree(tree, 'checkout', '-q', '--orphan', 'unrelated');
		inTree(tree, 'commit', '-q', '--allow-empty', '-m', 'Unrelated');
		await expect(tree.mergeBase()).rejects.toThrow('git merge failed');
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

	// a person who fixes the draft by hand pushes to the branch; a build that went on from the stale copy could not push
	it('opens at a commit pushed from elsewhere, so a build goes on from it', async () => {
		const { branch } = await pushed();
		const other = join(repo, `other-${String(n)}`);
		sh('clone', '-q', '-b', branch, join(repo, 'origin.git'), other);
		writeFileSync(join(other, 'fix.txt'), 'by hand\n');
		sh('-C', other, 'add', '-A');
		sh('-C', other, 'commit', '-q', '-m', 'Fix the check');
		sh('-C', other, 'push', '-q', 'origin', branch);

		const again = await open(branch);
		expect(await again.head()).toBe(sh('-C', other, 'rev-parse', 'HEAD'));
		expect(await again.built()).toEqual(new Set(['2']));
	});

	// the build's commits and a person's fix both stand, so the push is a fast-forward
	it('merges the remote in when both it and the remote moved without clashing', async () => {
		const { branch, tree } = await pushed();
		writeFileSync(join(tree.at.folder, 'b.txt'), 'work\n');
		await tree.commitTicket('3', 'Use it', 'Done.', 's2');
		const other = join(repo, `other-${String(n)}`);
		sh('clone', '-q', '-b', branch, join(repo, 'origin.git'), other);
		writeFileSync(join(other, 'fix.txt'), 'by hand\n');
		sh('-C', other, 'add', '-A');
		sh('-C', other, 'commit', '-q', '-m', 'Fix the check');
		sh('-C', other, 'push', '-q', 'origin', branch);

		const again = await open(branch);
		expect(await again.built()).toEqual(new Set(['2', '3']));
		expect(existsSync(join(again.at.folder, 'fix.txt'))).toBe(true);
		expect(existsSync(join(again.at.folder, 'b.txt'))).toBe(true);
		expect(await again.toRemote()).toBe(false);
		inTree(again, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
	});

	it('opens with its own commits when both it and the remote changed the same lines, and leaves the push to say so', async () => {
		const { branch, tree } = await pushed();
		writeFileSync(join(tree.at.folder, 'a.txt'), 'mine\n');
		await tree.commitTicket('3', 'Use it', 'Done.', 's2');
		const head = await tree.head();
		const other = join(repo, `other-${String(n)}`);
		sh('clone', '-q', '-b', branch, join(repo, 'origin.git'), other);
		writeFileSync(join(other, 'a.txt'), 'theirs\n');
		sh('-C', other, 'add', '-A');
		sh('-C', other, 'commit', '-q', '-m', 'Fix the check');
		sh('-C', other, 'push', '-q', 'origin', branch);

		const again = await open(branch);
		expect(await again.head()).toBe(head);
		expect(inTree(again, 'status', '--porcelain')).toBe('');
	});

	it('keeps commits the remote lacks, and says so', async () => {
		const { tree } = await pushed();
		writeFileSync(join(tree.at.folder, 'b.txt'), 'work\n');
		await tree.commitTicket('3', 'Use it', 'Done.', 's2');
		const head = await tree.head();
		expect(await tree.toRemote()).toBe(false);
		expect(await tree.head()).toBe(head);
	});

	describe('after a push that failed', () => {
		// a person pushes a commit of one file to the branch from a clone of their own; its head
		const personPushes = (branch: string, file: string) => {
			const other = join(repo, `person-${String((n += 1))}`);
			sh('clone', '-q', '-b', branch, join(repo, 'origin.git'), other);
			writeFileSync(join(other, file), 'by hand\n');
			sh('-C', other, 'add', '-A');
			sh('-C', other, 'commit', '-q', '-m', 'By hand');
			sh('-C', other, 'push', '-q', 'origin', branch);
			return sh('-C', other, 'rev-parse', 'HEAD');
		};
		// Nightjar's own commit of one file on the branch here, which it has not pushed
		const commit = async (tree: Worktree, file: string) => {
			writeFileSync(join(tree.at.folder, file), 'work\n');
			await tree.commitTicket('3', 'Use it', 'Done.', 's2');
			return tree.head();
		};

		it('counts the push as done when the remote already holds the commit', async () => {
			const { tree } = await pushed();
			expect(await tree.pushOutcome()).toBe('pushed');
		});

		it('counts the push as done when the remote holds the commit and a person pushed on top', async () => {
			const { branch, tree } = await pushed();
			personPushes(branch, 'mine.txt');
			expect(await tree.pushOutcome()).toBe('pushed');
		});

		it('says the branch diverged when both it and the remote have commits the other lacks', async () => {
			const { branch, tree } = await pushed();
			await commit(tree, 'b.txt');
			personPushes(branch, 'mine.txt');
			expect(await tree.pushOutcome()).toBe('diverged');
		});

		it('calls it a fault when the remote did not move', async () => {
			const { tree } = await pushed();
			await commit(tree, 'b.txt');
			expect(await tree.pushOutcome()).toBe('fault');
		});

		it('calls it a fault when the remote has no such branch', async () => {
			const tree = await open(`factory/r${String((n += 1))}-unpushed`);
			await commit(tree, 'b.txt');
			expect(await tree.pushOutcome()).toBe('fault');
		});

		it('holds no unpushed Ticket commit on a branch the remote has in full', async () => {
			const { tree } = await pushed();
			expect(await tree.holdsUnpushedTicket()).toBe(false);
		});

		it('holds none when only a Feedback commit is unpushed', async () => {
			const { tree } = await pushed();
			writeFileSync(join(tree.at.folder, 'b.txt'), 'work\n');
			await tree.commitFeedback(['7'], 'Renamed it.', 's2');
			expect(await tree.holdsUnpushedTicket()).toBe(false);
		});

		it('holds one when a Ticket commit is unpushed, with a Feedback commit on top of it', async () => {
			const { tree } = await pushed();
			await commit(tree, 'b.txt');
			writeFileSync(join(tree.at.folder, 'c.txt'), 'work\n');
			await tree.commitFeedback(['7'], 'Renamed it.', 's3');
			expect(await tree.holdsUnpushedTicket()).toBe(true);
		});

		it('holds one on a branch the remote lacks when a Ticket commit is on it', async () => {
			const tree = await open(`factory/r${String((n += 1))}-unpushed`);
			await commit(tree, 'b.txt');
			expect(await tree.holdsUnpushedTicket()).toBe(true);
		});

		it("sets its own commits aside on the -attempt-push branch and takes the remote's head", async () => {
			const { branch, tree } = await pushed();
			const mine = await commit(tree, 'b.txt');
			const theirs = personPushes(branch, 'mine.txt');
			await tree.pushOutcome();

			expect(await tree.setAsidePush()).toBe(`${branch}-attempt-push`);
			expect(await tree.head()).toBe(theirs);
			expect(inTree(tree, 'rev-parse', `${branch}-attempt-push`)).toBe(mine);
			expect(inTree(tree, 'status', '--porcelain')).toBe('');
			expect(await tree.toRemote()).toBe(true);
		});

		it('sets nothing aside when there is no remote head to go back to', async () => {
			const tree = await open(`factory/r${String((n += 1))}-unpushed`);
			const mine = await commit(tree, 'b.txt');
			expect(await tree.setAsidePush()).toBeNull();
			expect(await tree.head()).toBe(mine);
		});

		it('overwrites the -attempt-push branch on a second set-aside', async () => {
			const { branch, tree } = await pushed();
			await commit(tree, 'b.txt');
			personPushes(branch, 'mine.txt');
			await tree.pushOutcome();
			await tree.setAsidePush();

			const mine = await commit(tree, 'c.txt');
			const theirs = personPushes(branch, 'more.txt');
			expect(await tree.pushOutcome()).toBe('diverged');
			expect(await tree.setAsidePush()).toBe(`${branch}-attempt-push`);
			expect(inTree(tree, 'rev-parse', `${branch}-attempt-push`)).toBe(mine);
			expect(await tree.head()).toBe(theirs);
		});
	});
});
