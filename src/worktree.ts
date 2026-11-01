// Only Nightjar commits in the worktree or saves a failed attempt; the Code host pushes.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { firstLine, run, type Env } from './git.js';

// A git command Nightjar cannot go on without.
export class GitFailure extends Error {}

// Names the Ticket a commit built, so a later run on the branch knows what is done.
export const TICKET_TRAILER = 'Factory-Ticket';

// Names the Workflow Step a commit holds, so a later run knows it is done.
export const STEP_TRAILER = 'Factory-Step';

// The notes the Steps of a run share, in the worktree and never committed.
const NOTES = '.factory/notes';

const BRANCH_PREFIX = 'factory/';

// An item id as a piece of a branch name: whatever a ref may not hold becomes a dash.
const refPart = (id: string) => id.replace(/[^A-Za-z0-9_-]+/g, '-');

export function branchFor(id: string, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/, '');
	return `${BRANCH_PREFIX}${refPart(id)}${slug ? `-${slug}` : ''}`;
}

// Out of the checkout, so the one a person works in is never touched; the hash keeps two checkouts of one name apart.
export function worktreesFor(home: string, root: string): string {
	const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
	return join(home, '.nightjar', 'worktrees', `${basename(root)}-${hash}`);
}

export interface FeatureBranch {
	readonly branch: string;
	readonly folder: string;
	// the ref the Feature is built on and its diff is read against, such as origin/main
	readonly base: string;
}

export class Worktree {
	constructor(
		readonly at: FeatureBranch,
		private readonly env: Env
	) {}

	async git(args: readonly string[]): Promise<string> {
		const got = await run('git', args, this.at.folder, this.env);
		if (got.missing) throw new GitFailure('git is not on the PATH.');
		if (!got.ok) throw new GitFailure(`git ${args[0] ?? ''} failed: ${firstLine(got.err)}`);
		return got.out;
	}

	// In git's own folder for the worktree, so neither `git clean` nor a commit touches it.
	private async setupMarker(): Promise<string> {
		const path = (await this.git(['rev-parse', '--git-path', 'nightjar-setup'])).trim();
		return resolve(this.at.folder, path);
	}

	isSetUp = async () => existsSync(await this.setupMarker());

	markSetUp = async () => writeFileSync(await this.setupMarker(), '');

	head = async () => (await this.git(['rev-parse', 'HEAD'])).trim();

	ahead = async () =>
		Number((await this.git(['rev-list', '--count', `${this.at.base}..HEAD`])).trim());

	// The Tickets the branch's own commits built, from their trailers, oldest first.
	async built(): Promise<Set<string>> {
		const out = await this.git([
			'log',
			'--reverse',
			`--format=%(trailers:key=${TICKET_TRAILER},valueonly)`,
			`${this.at.base}..HEAD`
		]);
		return new Set([...out.matchAll(/^#(\S+)$/gm)].flatMap((m) => (m[1] ? [m[1]] : [])));
	}

	// One commit of everything the session left, or false when it left nothing.
	async commitTicket(
		id: string,
		title: string,
		summary: string,
		session: string
	): Promise<boolean> {
		await this.git(['add', '-A']);
		if ((await this.git(['diff', '--cached', '--name-only'])).trim() === '') return false;
		const message = `${title} (#${id})\n\n${summary.trim()}\n\n${TICKET_TRAILER}: #${id}\nFactory-Session: ${session}`;
		await this.git(['commit', '-q', '-m', message]);
		return true;
	}

	// The folder the Steps share, made, and kept out of every `git add` and `git clean` by the checkout's exclude file.
	async notes(): Promise<string> {
		const folder = join(this.at.folder, NOTES);
		mkdirSync(folder, { recursive: true });
		const path = (await this.git(['rev-parse', '--git-path', 'info/exclude'])).trim();
		const exclude = resolve(this.at.folder, path);
		const line = `/${NOTES}/`;
		const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
		if (!text.split('\n').includes(line)) {
			mkdirSync(dirname(exclude), { recursive: true });
			appendFileSync(exclude, `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
		}
		return folder;
	}

	// The Steps the branch's own commits hold, as their trailers name them.
	async stepsDone(): Promise<Set<string>> {
		const out = await this.git([
			'log',
			`--format=%(trailers:key=${STEP_TRAILER},valueonly)`,
			`${this.at.base}..HEAD`
		]);
		return new Set(out.split('\n').flatMap((l) => (l.trim() === '' ? [] : [l.trim()])));
	}

	// The Feature's diff against its base, cut at `limit` characters.
	async diff(limit: number): Promise<{ text: string; truncated: boolean }> {
		const text = await this.git(['diff', `${this.at.base}...HEAD`]);
		return text.length > limit
			? { text: text.slice(0, limit), truncated: true }
			: { text, truncated: false };
	}

	// One commit of what a Step left, naming the Workflow and the Step; false when it changed no file.
	async commitStep(o: {
		workflow: string;
		step: string;
		key: string;
		after: string | null;
		summary: string;
		session: string;
	}): Promise<boolean> {
		await this.git(['add', '-A']);
		if ((await this.git(['diff', '--cached', '--name-only'])).trim() === '') return false;
		const subject = `${o.workflow}: ${o.step}${o.after === null ? '' : ` (after #${o.after})`}`;
		const message = `${subject}\n\n${o.summary.trim()}\n\n${STEP_TRAILER}: ${o.key}\nFactory-Session: ${o.session}`;
		await this.git(['commit', '-q', '-m', message]);
		return true;
	}

	// Throws away what a Step left, keeping nothing: the Step is listed as not done.
	async revert(before: string): Promise<void> {
		await this.git(['reset', '-q', '--hard', before]);
		await this.git(['clean', '-q', '-fd']);
	}

	// Keeps what the session left on a side branch, which it names; null when it left nothing.
	async discard(before: string, ticket: string): Promise<string | null> {
		await this.git(['add', '-A']);
		const moved = (await this.head()) !== before;
		const staged = (await this.git(['diff', '--cached', '--name-only'])).trim() !== '';
		let side: string | null = null;
		if (moved || staged) {
			const tree = (await this.git(['write-tree'])).trim();
			const saved = (
				await this.git([
					'commit-tree',
					'-p',
					'HEAD',
					'-m',
					`nightjar: the failed attempt at #${ticket}`,
					tree
				])
			).trim();
			side = `${this.at.branch}-attempt-${refPart(ticket)}`;
			await this.git(['branch', '-f', side, saved]);
		}
		await this.git(['reset', '-q', '--hard', before]);
		await this.git(['clean', '-q', '-fd']);
		return side;
	}
}

function inRoot(root: string, args: readonly string[], env: Env) {
	return run('git', ['-C', root, ...args], root, env);
}

const hasRef = async (root: string, ref: string, env: Env) =>
	(await inRoot(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], env)).ok;

// Reuses the worktree a run before left, else the pushed branch; a worktree a stopped run left dirty is cleaned.
export async function openWorktree(
	root: string,
	worktrees: string,
	branch: string,
	baseBranch: string,
	env: Env
): Promise<Worktree> {
	const must = async (args: readonly string[]) => {
		const got = await inRoot(root, args, env);
		if (got.missing) throw new GitFailure('git is not on the PATH.');
		if (!got.ok) throw new GitFailure(`git ${args[0] ?? ''} failed: ${firstLine(got.err)}`);
	};
	await must(['fetch', '-q', 'origin', baseBranch]);
	// the branch a run before pushed, which may not be there yet
	await inRoot(
		root,
		['fetch', '-q', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`],
		env
	);
	const base = `origin/${baseBranch}`;
	const folder = join(worktrees, branch.slice(BRANCH_PREFIX.length));
	const tree = new Worktree({ branch, folder, base }, env);
	if (existsSync(folder)) {
		await tree.git(['reset', '-q', '--hard']);
		await tree.git(['clean', '-q', '-fd']);
		return tree;
	}
	await must(['worktree', 'prune']);
	if (await hasRef(root, `refs/heads/${branch}`, env)) {
		await must(['worktree', 'add', '-q', folder, branch]);
	} else if (await hasRef(root, `refs/remotes/origin/${branch}`, env)) {
		await must(['worktree', 'add', '-q', '--no-track', '-b', branch, folder, `origin/${branch}`]);
	} else {
		await must(['worktree', 'add', '-q', '--no-track', '-b', branch, folder, base]);
	}
	return tree;
}

// The branch origin's HEAD points at, such as main, or null when origin names none.
export async function defaultBranch(root: string, env: Env): Promise<string | null> {
	const got = await inRoot(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env);
	return got.ok ? got.out.trim().replace(/^origin\//, '') || null : null;
}

// How git signs a commit here: a locked signing key fails every commit of the run.
export async function signing(root: string, env: Env): Promise<'signs' | 'unsigned' | 'fails'> {
	const sign = await inRoot(root, ['config', '--bool', 'commit.gpgsign'], env);
	if (sign.out.trim() !== 'true') return 'unsigned';
	const probe = ['commit-tree', '-S', '-p', 'HEAD', '-m', 'nightjar preflight', 'HEAD^{tree}'];
	return (await inRoot(root, probe, env)).ok ? 'signs' : 'fails';
}
