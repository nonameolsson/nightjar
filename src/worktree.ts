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

// Counts the Pull-check fixes pushed to a branch, so a later run knows how many rounds it had.
export const PULL_FIX_TRAILER = 'Factory-Pull-Fix';

// Counts the Conflict fixes pushed to a branch, so a later run knows how many rounds it had.
export const CONFLICTS_TRAILER = 'Factory-Conflicts';

// Lists the feedback a Feedback round answered, by id; feedback no such trailer names is unanswered.
export const FEEDBACK_TRAILER = 'Factory-Feedback';

// Names the Review round of the build a commit holds.
export const REVIEW_TRAILER = 'Factory-Review';

// Names the Session a commit came from, so a later round can resume it.
export const SESSION_TRAILER = 'Factory-Session';

// Every trailer Nightjar writes starts with it; a head commit without one is not Nightjar's.
export const TRAILER_PREFIX = 'Factory-';

// The notes the Steps of a run share, in the worktree and never committed.
const NOTES = '.factory/notes';

// Every branch Nightjar builds on starts with it.
export const BRANCH_PREFIX = 'factory/';

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

// What a commit says, so the real and the in-memory worktree word it alike.
export function ticketCommitMessage(
	id: string,
	title: string,
	summary: string,
	session: string
): string {
	return `${title} (#${id})\n\n${summary.trim()}\n\n${TICKET_TRAILER}: #${id}\n${SESSION_TRAILER}: ${session}`;
}

// The commit of one Pull-check fix round, the `round`th on the branch.
export function pullFixCommitMessage(round: number, summary: string, session: string): string {
	return `Fix the Pull checks, round ${String(round)}\n\n${summary.trim()}\n\n${PULL_FIX_TRAILER}: ${String(round)}\n${SESSION_TRAILER}: ${session}`;
}

// The merge commit of one Conflict fix, the `round`th on the branch; `base` is the ref it merged in.
export function conflictFixCommitMessage(
	round: number,
	base: string,
	summary: string,
	session: string
): string {
	return `Merge ${base} into the branch, conflict fix round ${String(round)}\n\n${summary.trim()}\n\n${CONFLICTS_TRAILER}: ${String(round)}\n${SESSION_TRAILER}: ${session}`;
}

// What merging the base into the branch came to: it completed, or it stopped on the files it names.
export type MergeOutcome =
	{ readonly kind: 'clean' } | { readonly kind: 'conflicts'; readonly files: readonly string[] };

// The commit of one Review round, the `round`th of its build.
export function reviewCommitMessage(round: number, summary: string, session: string): string {
	return `Answer the Review, round ${String(round)}\n\n${summary.trim()}\n\n${REVIEW_TRAILER}: ${String(round)}\n${SESSION_TRAILER}: ${session}`;
}

// Names the request for changes that started a Feedback round with no Go; the branch's automatic rounds are counted by it.
export const FEEDBACK_ASKED_TRAILER = 'Factory-Feedback-Asked';

// The commit of one Feedback round, its trailer naming only the feedback it answered; `asked` is the request for changes that started a round with no Go.
export function feedbackCommitMessage(
	answered: readonly string[],
	summary: string,
	session: string,
	asked?: string
): string {
	const started = asked === undefined ? '' : `\n${FEEDBACK_ASKED_TRAILER}: ${asked}`;
	return `Answer feedback on the pull request\n\n${summary.trim()}\n\n${FEEDBACK_TRAILER}: ${answered.join(', ')}${started}\n${SESSION_TRAILER}: ${session}`;
}

// The feedback ids the values of Factory-Feedback trailers name.
export const feedbackIds = (values: string): string[] =>
	values.split(/[\s,]+/).filter((id) => id !== '');

export interface StepCommit {
	readonly workflow: string;
	readonly step: string;
	readonly key: string;
	readonly after: string | null;
	readonly summary: string;
	readonly session: string;
}

export function stepCommitMessage(o: StepCommit): string {
	const subject = `${o.workflow}: ${o.step}${o.after === null ? '' : ` (after #${o.after})`}`;
	return `${subject}\n\n${o.summary.trim()}\n\n${STEP_TRAILER}: ${o.key}\n${SESSION_TRAILER}: ${o.session}`;
}

// The side branch a failed attempt at a Ticket is kept on.
export function attemptBranch(branch: string, ticket: string): string {
	return `${branch}-attempt-${refPart(ticket)}`;
}

// The Feature's folder under `worktrees`: its branch name without the prefix.
export function folderFor(worktrees: string, branch: string): string {
	return join(worktrees, branch.slice(BRANCH_PREFIX.length));
}

// The git in a Feature's worktree, behind the seam `Deps.openWorktree` hands the build loop.
export interface Worktree {
	readonly at: FeatureBranch;
	// whether the worktree's setup command ran, and a note that it has
	isSetUp(): Promise<boolean>;
	markSetUp(): Promise<void>;
	// where the branch stands now, as an opaque mark `revert` and `discard` go back to
	head(): Promise<string>;
	// how many commits the branch holds that its base does not
	ahead(): Promise<number>;
	// The Tickets the branch's own commits built, from their trailers.
	built(): Promise<Set<string>>;
	// One commit of everything the session left, or false when it left nothing.
	commitTicket(id: string, title: string, summary: string, session: string): Promise<boolean>;
	// The folder the Steps share, made, and kept out of the branch.
	notes(): Promise<string>;
	// The Steps the branch's own commits hold, as their trailers name them.
	stepsDone(): Promise<Set<string>>;
	// The Feature's diff against its base, cut at `limit` characters.
	diff(limit: number): Promise<{ text: string; truncated: boolean }>;
	// One commit of what a Step left; false when it changed no file.
	commitStep(o: StepCommit): Promise<boolean>;
	// Everything in the worktree now, committed or not, as an opaque mark `restore` goes back to; a try of a fix round starts from what the build left, which no commit holds.
	snapshot(): Promise<string>;
	restore(mark: string): Promise<void>;
	// Throws away what a Step left, keeping nothing: the Step is listed as not done.
	revert(before: string): Promise<void>;
	// Keeps what the session left on a side branch, which it names; null when it left nothing.
	discard(before: string, ticket: string): Promise<string | null>;
	// Moves the branch on to the commit the remote holds, when that loses no commit of its own; false when the remote has no such branch or the branch holds commits the remote lacks.
	toRemote(): Promise<boolean>;
	// After a push that failed, the branch fetched again: the remote holds the commit, each side has commits the other lacks, or neither.
	pushOutcome(): Promise<PushOutcome>;
	// Keeps the branch's commits on its -attempt-push side branch, overwriting one kept before, and takes the remote's head; the side branch's name.
	setAsidePush(): Promise<string>;
	// The trailers of the head commit, by key; the last value of a key given twice.
	headTrailers(): Promise<ReadonlyMap<string, string>>;
	// How many Pull-check fixes the branch's own commits hold, from their trailers.
	pullFixes(): Promise<number>;
	// One commit of what a Pull-check fix round left, the `round`th; false when it changed no file.
	commitPullFix(round: number, summary: string, session: string): Promise<boolean>;
	// The feedback the branch's own commits answered, as their Factory-Feedback trailers name it.
	answeredFeedback(): Promise<Set<string>>;
	// One commit of what a Feedback round left, naming the feedback it answered and, for a round with no Go, the request for changes that started it; its short id, or null when it changed no file.
	commitFeedback(
		answered: readonly string[],
		summary: string,
		session: string,
		asked?: string
	): Promise<string | null>;
	// One commit of what a Review round left, the `round`th of its build; false when it changed no file.
	commitReview(round: number, summary: string, session: string): Promise<boolean>;
	// Merges the base, as the worktree last fetched it, into the branch without committing, never a rebase; the merge is left pending for `commitConflictFix`, with the files it stopped on holding conflict markers. Clean when the merge completed, or when the branch already holds the base.
	mergeBase(): Promise<MergeOutcome>;
	// One merge commit of the pending merge and what the Session left, the `round`th Conflict fix, keeping every earlier commit; false when no merge is pending.
	commitConflictFix(round: number, summary: string, session: string): Promise<boolean>;
	// How many Conflict fixes the branch's own commits hold, from their trailers.
	conflictFixes(): Promise<number>;
}

// The trailers of a commit message: the `Key: value` lines of its last paragraph, by key.
export function trailersOf(message: string): Map<string, string> {
	const paragraphs = message.trimEnd().split(/\n\s*\n/);
	const last = paragraphs.at(-1) ?? '';
	const found = new Map<string, string>();
	for (const line of last.split('\n')) {
		const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
		if (m?.[1] !== undefined) found.set(m[1], (m[2] ?? '').trim());
	}
	return found;
}

// What a push that failed turns out to be: the remote holds the commit after all, a person pushed to the branch, or anything else.
export type PushOutcome = 'pushed' | 'diverged' | 'fault';

// The side branch a push the remote rejected keeps Nightjar's commits on.
export const pushAttemptBranch = (branch: string) => attemptBranch(branch, 'push');

// Opens the worktree of a Feature's branch, reusing what a run before left.
export type OpenWorktree = (
	root: string,
	worktrees: string,
	branch: string,
	baseBranch: string,
	env: Env
) => Promise<Worktree>;

export class GitWorktree implements Worktree {
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
		await this.git(['commit', '-q', '-m', ticketCommitMessage(id, title, summary, session)]);
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
	async commitStep(o: StepCommit): Promise<boolean> {
		await this.git(['add', '-A']);
		if ((await this.git(['diff', '--cached', '--name-only'])).trim() === '') return false;
		await this.git(['commit', '-q', '-m', stepCommitMessage(o)]);
		return true;
	}

	async snapshot(): Promise<string> {
		await this.git(['add', '-A']);
		return (await this.git(['write-tree'])).trim();
	}

	// The commit a pending merge is merging in, or null when none is pending.
	private async mergeHead(): Promise<string | null> {
		const got = await run(
			'git',
			['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
			this.at.folder,
			this.env
		);
		return got.ok ? got.out.trim() : null;
	}

	async restore(mark: string): Promise<void> {
		// `reset --hard` ends a pending merge, which a try of a fix round must not
		const merging = await this.mergeHead();
		await this.git(['reset', '-q', '--hard', 'HEAD']);
		await this.git(['clean', '-q', '-fd']);
		await this.git(['read-tree', '-u', '--reset', mark]);
		if (merging !== null) {
			// git has no command to begin a merge, so the file it keeps the merge in is written
			const path = (await this.git(['rev-parse', '--git-path', 'MERGE_HEAD'])).trim();
			writeFileSync(resolve(this.at.folder, path), `${merging}\n`);
		}
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
			side = attemptBranch(this.at.branch, ticket);
			await this.git(['branch', '-f', side, saved]);
		}
		await this.git(['reset', '-q', '--hard', before]);
		await this.git(['clean', '-q', '-fd']);
		return side;
	}

	// The remote branch was fetched when the worktree opened; a branch that is behind it moves on, one ahead of it stays.
	async toRemote(): Promise<boolean> {
		const remote = `refs/remotes/origin/${this.at.branch}`;
		const theirs = await run(
			'git',
			['rev-parse', '--verify', '--quiet', `${remote}^{commit}`],
			this.at.folder,
			this.env
		);
		if (!theirs.ok) return false;
		if (theirs.out.trim() === (await this.head())) return true;
		const behind = await run(
			'git',
			['merge-base', '--is-ancestor', 'HEAD', remote],
			this.at.folder,
			this.env
		);
		if (!behind.ok) return false;
		await this.git(['reset', '-q', '--hard', remote]);
		return true;
	}

	// A branch with commits of its own and the remote's: the remote's merged in when the two do not clash, else the branch left as it was.
	async mergeRemote(): Promise<boolean> {
		const remote = `refs/remotes/origin/${this.at.branch}`;
		const theirs = await run(
			'git',
			['rev-parse', '--verify', '--quiet', `${remote}^{commit}`],
			this.at.folder,
			this.env
		);
		if (!theirs.ok) return false;
		const merged = await run('git', ['merge', '-q', '--no-edit', remote], this.at.folder, this.env);
		if (merged.ok) return true;
		await run('git', ['merge', '--abort'], this.at.folder, this.env);
		return false;
	}

	// Sorted by git's view of the two heads, not by what the push said, so it reads alike on every Code host.
	async pushOutcome(): Promise<PushOutcome> {
		const remote = `refs/remotes/origin/${this.at.branch}`;
		const refspec = `+refs/heads/${this.at.branch}:${remote}`;
		const fetched = await run('git', ['fetch', '-q', 'origin', refspec], this.at.folder, this.env);
		if (!fetched.ok) return 'fault';
		const holds = (ancestor: string, of: string) =>
			run('git', ['merge-base', '--is-ancestor', ancestor, of], this.at.folder, this.env);
		if ((await holds('HEAD', remote)).ok) return 'pushed';
		if ((await holds(remote, 'HEAD')).ok) return 'fault';
		return 'diverged';
	}

	async setAsidePush(): Promise<string> {
		const side = pushAttemptBranch(this.at.branch);
		await this.git(['branch', '-f', side, 'HEAD']);
		await this.git(['reset', '-q', '--hard', `refs/remotes/origin/${this.at.branch}`]);
		await this.git(['clean', '-q', '-fd']);
		return side;
	}

	async headTrailers(): Promise<ReadonlyMap<string, string>> {
		const out = await this.git(['log', '-1', '--format=%(trailers:only,unfold)']);
		const found = new Map<string, string>();
		for (const line of out.split('\n')) {
			const m = /^([^:\s]+):\s*(.*)$/.exec(line);
			if (m?.[1] !== undefined) found.set(m[1], (m[2] ?? '').trim());
		}
		return found;
	}

	async pullFixes(): Promise<number> {
		const out = await this.git([
			'log',
			`--format=%(trailers:key=${PULL_FIX_TRAILER},valueonly)`,
			`${this.at.base}..HEAD`
		]);
		return out.split('\n').filter((l) => l.trim() !== '').length;
	}

	async commitPullFix(round: number, summary: string, session: string): Promise<boolean> {
		await this.git(['add', '-A']);
		if ((await this.git(['diff', '--cached', '--name-only'])).trim() === '') return false;
		await this.git(['commit', '-q', '-m', pullFixCommitMessage(round, summary, session)]);
		return true;
	}

	async answeredFeedback(): Promise<Set<string>> {
		const out = await this.git([
			'log',
			`--format=%(trailers:key=${FEEDBACK_TRAILER},valueonly,unfold)`,
			`${this.at.base}..HEAD`
		]);
		return new Set(feedbackIds(out));
	}

	async commitFeedback(
		answered: readonly string[],
		summary: string,
		session: string,
		asked?: string
	): Promise<string | null> {
		await this.git(['add', '-A']);
		if ((await this.git(['diff', '--cached', '--name-only'])).trim() === '') return null;
		const message = feedbackCommitMessage(answered, summary, session, asked);
		await this.git(['commit', '-q', '-m', message]);
		return (await this.git(['rev-parse', '--short', 'HEAD'])).trim();
	}

	async commitReview(round: number, summary: string, session: string): Promise<boolean> {
		await this.git(['add', '-A']);
		if ((await this.git(['diff', '--cached', '--name-only'])).trim() === '') return false;
		await this.git(['commit', '-q', '-m', reviewCommitMessage(round, summary, session)]);
		return true;
	}

	async mergeBase(): Promise<MergeOutcome> {
		const merged = await run(
			'git',
			['merge', '--no-commit', '--no-ff', this.at.base],
			this.at.folder,
			this.env
		);
		if (merged.missing) throw new GitFailure('git is not on the PATH.');
		if (merged.ok) return { kind: 'clean' };
		const out = await this.git(['diff', '--name-only', '--diff-filter=U']);
		const files = out.split('\n').filter((l) => l !== '');
		// a merge that stopped on no file did not stop on conflicts: git refused it
		if (files.length === 0) {
			const why = firstLine(merged.err) || firstLine(merged.out);
			throw new GitFailure(`git merge failed: ${why}`);
		}
		return { kind: 'conflicts', files };
	}

	async commitConflictFix(round: number, summary: string, session: string): Promise<boolean> {
		if ((await this.mergeHead()) === null) return false;
		await this.git(['add', '-A']);
		const message = conflictFixCommitMessage(round, this.at.base, summary, session);
		await this.git(['commit', '-q', '-m', message]);
		return true;
	}

	async conflictFixes(): Promise<number> {
		const out = await this.git([
			'log',
			`--format=%(trailers:key=${CONFLICTS_TRAILER},valueonly)`,
			`${this.at.base}..HEAD`
		]);
		return out.split('\n').filter((l) => l.trim() !== '').length;
	}
}

function inRoot(root: string, args: readonly string[], env: Env) {
	return run('git', ['-C', root, ...args], root, env);
}

const hasRef = async (root: string, ref: string, env: Env) =>
	(await inRoot(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], env)).ok;

// Reuses the worktree a run before left, else the pushed branch; a worktree a stopped run left dirty is cleaned.
export const openWorktree: OpenWorktree = async (root, worktrees, branch, baseBranch, env) => {
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
	const folder = folderFor(worktrees, branch);
	const tree = new GitWorktree({ branch, folder, base }, env);
	if (existsSync(folder)) {
		await tree.git(['reset', '-q', '--hard']);
		await tree.git(['clean', '-q', '-fd']);
	} else {
		await must(['worktree', 'prune']);
		if (await hasRef(root, `refs/heads/${branch}`, env)) {
			await must(['worktree', 'add', '-q', folder, branch]);
		} else if (await hasRef(root, `refs/remotes/origin/${branch}`, env)) {
			await must(['worktree', 'add', '-q', '--no-track', '-b', branch, folder, `origin/${branch}`]);
		} else {
			await must(['worktree', 'add', '-q', '--no-track', '-b', branch, folder, base]);
		}
	}
	// what a person pushed to the branch since, such as a fix to its check, so the next push is not rejected;
	// a branch with commits on both sides takes the remote's in by a merge, and one that clashes stays as it is, and its push says so
	if (!(await tree.toRemote())) await tree.mergeRemote();
	return tree;
};

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
