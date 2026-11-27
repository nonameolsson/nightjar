// The worktree's in-memory adapter, which the build loop's specs run over in place of real git: a branch is a list of commits, and what a Session leaves is files written to it.
import {
	CONFLICTS_TRAILER,
	FEEDBACK_TRAILER,
	PULL_FIX_TRAILER,
	attemptBranch,
	conflictFixCommitMessage,
	feedbackCommitMessage,
	feedbackIds,
	folderFor,
	pushAttemptBranch,
	pullFixCommitMessage,
	reviewCommitMessage,
	stepCommitMessage,
	ticketCommitMessage,
	trailersOf,
	type FeatureBranch,
	type MergeOutcome,
	type OpenWorktree,
	type PushOutcome,
	type StepCommit,
	type Worktree
} from '../worktree.js';

interface Commit {
	readonly message: string;
	readonly files: ReadonlyMap<string, string>;
	// what its trailer names, if it has one
	readonly ticket?: string;
	readonly step?: string;
	// for a merge commit, how many commits of the base it holds
	readonly mergedBase?: number;
}

// A merge begun and not yet committed: the base commits it takes in, up to this many.
interface PendingMerge {
	readonly upTo: number;
}

interface Folder {
	commits: Commit[];
	// what is written and not yet committed
	dirty: Map<string, string>;
	setUp: boolean;
	// the base's commits when the branch was made, which the branch holds from the start
	forkedAt: number | null;
	merge: PendingMerge | null;
}

// One commit of a base branch: the files it writes.
type BaseCommit = ReadonlyMap<string, string>;

export interface MemoryWorktrees {
	readonly open: OpenWorktree;
	// A Session writing a file in the worktree at `folder`.
	write(folder: string, file: string, text?: string): void;
	// Whether the file is in the worktree now, committed or not.
	has(folder: string, file: string): boolean;
	// The files written and not committed, which a clean worktree has none of.
	left(folder: string): string[];
	// The branch's commit messages, newest first.
	messages(folder: string): string[];
	// The first line of each, newest first.
	subjects(folder: string): string[];
	// The side branches failed attempts were kept on, with the files each kept.
	readonly sides: ReadonlyMap<string, string[]>;
	// A person's own commit on the branch, of one file, with no trailer.
	commitAsPerson(folder: string, message: string, file: string): void;
	// A commit of one file on a base branch, which a Feature's branch holds only once merged in; a branch is made on its first.
	moveBase(baseBranch: string, file: string, text: string): void;
}

// The messages of the commits the Code host holds on a branch, oldest first, or null for one it lacks.
export type RemoteBranch = (branch: string) => readonly string[] | null;

// With no `remote`, the model has one copy of each branch, which is the remote's too.
export function memoryWorktrees(remote?: RemoteBranch): MemoryWorktrees {
	const folders = new Map<string, Folder>();
	const sides = new Map<string, string[]>();
	const bases = new Map<string, BaseCommit[]>();
	const baseOf = (name: string): BaseCommit[] => {
		let got = bases.get(name);
		if (got === undefined) {
			got = [];
			bases.set(name, got);
		}
		return got;
	};
	const state = (folder: string): Folder => {
		let got = folders.get(folder);
		if (got === undefined) {
			got = { commits: [], dirty: new Map(), setUp: false, forkedAt: null, merge: null };
			folders.set(folder, got);
		}
		return got;
	};

	const open: OpenWorktree = (_root, worktrees, branch, baseBranch) => {
		const at: FeatureBranch = {
			branch,
			folder: folderFor(worktrees, branch),
			base: `origin/${baseBranch}`
		};
		const folder = state(at.folder);
		// a worktree a stopped run left dirty, or in a merge, is cleaned, as the real one is
		folder.dirty.clear();
		folder.merge = null;
		const base = baseOf(baseBranch);
		folder.forkedAt ??= base.length;
		return Promise.resolve(new MemoryWorktree(at, folder, sides, remote, base));
	};

	return {
		open,
		write: (folder, file, text = 'work\n') => {
			state(folder).dirty.set(file, text);
		},
		has: (folder, file) => {
			const got = state(folder);
			return got.dirty.has(file) || got.commits.some((c) => c.files.has(file));
		},
		left: (folder) => [...state(folder).dirty.keys()],
		messages: (folder) => [...state(folder).commits].reverse().map((c) => c.message),
		subjects: (folder) =>
			[...state(folder).commits].reverse().map((c) => c.message.split('\n')[0] ?? ''),
		sides,
		commitAsPerson: (folder, message, file) => {
			state(folder).commits.push({ message, files: new Map([[file, 'by hand\n']]) });
		},
		moveBase: (baseBranch, file, text) => {
			baseOf(baseBranch).push(new Map([[file, text]]));
		}
	};
}

class MemoryWorktree implements Worktree {
	// how many commits the base branch had when the worktree opened
	private readonly seen: number;

	constructor(
		readonly at: FeatureBranch,
		private readonly folder: Folder,
		private readonly sides: Map<string, string[]>,
		private readonly remote: RemoteBranch | undefined,
		// the commits of the base branch, which the worktree sees as of when it opened
		private readonly base: readonly BaseCommit[]
	) {
		this.seen = base.length;
	}

	isSetUp = () => Promise.resolve(this.folder.setUp);

	markSetUp = () => {
		this.folder.setUp = true;
		return Promise.resolve();
	};

	// the number of commits, which `reset` goes back to
	head = () => Promise.resolve(String(this.folder.commits.length));

	ahead = () => Promise.resolve(this.folder.commits.length);

	built = () =>
		Promise.resolve(
			new Set(this.folder.commits.flatMap((c) => (c.ticket === undefined ? [] : [c.ticket])))
		);

	read(path: string) {
		const dirty = this.folder.dirty.get(path);
		if (dirty !== undefined) return Promise.resolve(dirty);
		const commit = [...this.folder.commits].reverse().find((c) => c.files.has(path));
		return Promise.resolve(commit?.files.get(path) ?? null);
	}

	stepsDone = () =>
		Promise.resolve(
			new Set(this.folder.commits.flatMap((c) => (c.step === undefined ? [] : [c.step])))
		);

	// Only the folder's name: the Steps' notes are not part of the model.
	notes = () => Promise.resolve(`${this.at.folder}/.factory/notes`);

	diff(limit: number) {
		const text = this.folder.commits
			.flatMap((c) => [...c.files])
			.map(([file, body]) => `diff --git a/${file} b/${file}\n+++ b/${file}\n+${body}`)
			.join('\n');
		return Promise.resolve(
			text.length > limit
				? { text: text.slice(0, limit), truncated: true }
				: { text, truncated: false }
		);
	}

	private commit(commit: Omit<Commit, 'files'>): boolean {
		if (this.folder.dirty.size === 0) return false;
		this.folder.commits.push({ ...commit, files: this.folder.dirty });
		this.folder.dirty = new Map();
		return true;
	}

	commitTicket(id: string, title: string, summary: string, session: string) {
		const message = ticketCommitMessage(id, title, summary, session);
		return Promise.resolve(this.commit({ message, ticket: id }));
	}

	commitStep(o: StepCommit) {
		return Promise.resolve(this.commit({ message: stepCommitMessage(o), step: o.key }));
	}

	private reset(before: string) {
		this.folder.commits.length = Number(before);
		this.folder.dirty.clear();
		this.folder.merge = null;
	}

	snapshot = () => Promise.resolve(JSON.stringify([...this.folder.dirty]));

	restore(mark: string) {
		this.folder.dirty = new Map(JSON.parse(mark) as [string, string][]);
		return Promise.resolve();
	}

	revert(before: string) {
		this.reset(before);
		return Promise.resolve();
	}

	// How many commits the branch here shares with the remote's from the start, by message, and the remote's; null for a branch the remote lacks.
	private fetched(): { theirs: readonly string[]; same: number } | null {
		const theirs = this.remote?.(this.at.branch) ?? null;
		if (theirs === null) return null;
		const ours = this.folder.commits;
		let same = 0;
		while (same < ours.length && same < theirs.length && ours[same]?.message === theirs[same]) {
			same += 1;
		}
		return { theirs, same };
	}

	// The branch here as the remote's: the commits they share, then the remote's own, which carry no file of the model.
	private takeRemote(theirs: readonly string[], same: number) {
		this.folder.commits.length = same;
		this.folder.commits.push(
			...theirs.slice(same).map((message) => ({ message, files: new Map() }))
		);
		this.folder.dirty.clear();
	}

	toRemote = () => {
		if (this.remote === undefined) return Promise.resolve(true);
		const got = this.fetched();
		if (got === null || got.same < this.folder.commits.length) return Promise.resolve(false);
		this.takeRemote(got.theirs, got.same);
		return Promise.resolve(true);
	};

	pushOutcome = (): Promise<PushOutcome> => {
		const got = this.fetched();
		if (got === null) return Promise.resolve('fault');
		if (got.same === this.folder.commits.length) return Promise.resolve('pushed');
		return Promise.resolve(got.same === got.theirs.length ? 'fault' : 'diverged');
	};

	holdsUnpushedTicket = () => {
		if (this.remote === undefined) return Promise.resolve(false);
		const same = this.fetched()?.same ?? 0;
		return Promise.resolve(this.folder.commits.slice(same).some((c) => c.ticket !== undefined));
	};

	setAsidePush = () => {
		const got = this.fetched();
		if (got === null) return Promise.resolve(null);
		const side = pushAttemptBranch(this.at.branch);
		this.sides.set(
			side,
			this.folder.commits.slice(got.same).flatMap((c) => [...c.files.keys()])
		);
		this.takeRemote(got.theirs, got.same);
		return Promise.resolve(side);
	};

	headTrailers = (): Promise<ReadonlyMap<string, string>> => {
		const head = this.folder.commits.at(-1);
		return Promise.resolve(head === undefined ? new Map() : trailersOf(head.message));
	};

	pullFixes = () =>
		Promise.resolve(
			this.folder.commits.filter((c) => trailersOf(c.message).has(PULL_FIX_TRAILER)).length
		);

	commitPullFix(round: number, summary: string, session: string) {
		return Promise.resolve(this.commit({ message: pullFixCommitMessage(round, summary, session) }));
	}

	answeredFeedback = () =>
		Promise.resolve(
			new Set(
				this.folder.commits.flatMap((c) =>
					feedbackIds(trailersOf(c.message).get(FEEDBACK_TRAILER) ?? '')
				)
			)
		);

	// a short id made of the commit's place on the branch, as git's is made of its hash
	commitFeedback(answered: readonly string[], summary: string, session: string, asked?: string) {
		const message = feedbackCommitMessage(answered, summary, session, asked);
		const made = this.commit({ message });
		return Promise.resolve(made ? `c0ffee${String(this.folder.commits.length)}` : null);
	}

	commitReview(round: number, summary: string, session: string) {
		return Promise.resolve(this.commit({ message: reviewCommitMessage(round, summary, session) }));
	}

	// How many commits of the base the branch holds: those it forked from, and those a merge commit took in.
	private holdsOfBase(): number {
		const merged = this.folder.commits.map((c) => c.mergedBase ?? 0);
		return Math.max(this.folder.forkedAt ?? 0, ...merged);
	}

	// A file both sides wrote differently is a conflict, and holds both sides between markers, as git leaves it; a file only the base wrote is taken in.
	mergeBase(): Promise<MergeOutcome> {
		this.folder.dirty.clear();
		const held = this.holdsOfBase();
		if (this.seen <= held) {
			this.folder.merge = null;
			return Promise.resolve({ kind: 'clean' });
		}
		this.folder.merge = { upTo: this.seen };
		const ours = new Map(this.folder.commits.flatMap((c) => [...c.files]));
		const conflicts: string[] = [];
		for (const commit of this.base.slice(held, this.seen)) {
			for (const [file, theirs] of commit) {
				const mine = ours.get(file);
				if (mine === undefined) {
					this.folder.dirty.set(file, theirs);
				} else if (mine !== theirs) {
					const markers = `<<<<<<< HEAD\n${mine}=======\n${theirs}>>>>>>> ${this.at.base}\n`;
					this.folder.dirty.set(file, markers);
					conflicts.push(file);
				}
			}
		}
		return Promise.resolve(
			conflicts.length === 0 ? { kind: 'clean' } : { kind: 'conflicts', files: conflicts.sort() }
		);
	}

	commitConflictFix(round: number, summary: string, session: string) {
		const merge = this.folder.merge;
		if (merge === null) return Promise.resolve(false);
		const message = conflictFixCommitMessage(round, this.at.base, summary, session);
		this.folder.commits.push({ message, files: this.folder.dirty, mergedBase: merge.upTo });
		this.folder.dirty = new Map();
		this.folder.merge = null;
		return Promise.resolve(true);
	}

	conflictFixes = () =>
		Promise.resolve(
			this.folder.commits.filter((c) => trailersOf(c.message).has(CONFLICTS_TRAILER)).length
		);

	// Each base commit the branch lacks, by its place on the base and the files it writes: the model's base commits have no message.
	baseCommits(limit: number) {
		const held = this.holdsOfBase();
		const text = this.base
			.slice(held, this.seen)
			.map((c, i) => `base commit ${String(held + i + 1)}: writes ${[...c.keys()].join(', ')}`)
			.join('\n');
		return Promise.resolve(
			text.length > limit
				? { text: text.slice(0, limit), truncated: true }
				: { text, truncated: false }
		);
	}

	behindBase = () => Promise.resolve(this.seen > this.holdsOfBase());

	changed = () => Promise.resolve([...this.folder.dirty.keys()].sort());

	discard(before: string, ticket: string) {
		const kept = [
			...this.folder.commits.slice(Number(before)).flatMap((c) => [...c.files.keys()]),
			...this.folder.dirty.keys()
		];
		this.reset(before);
		if (kept.length === 0) return Promise.resolve(null);
		const side = attemptBranch(this.at.branch, ticket);
		this.sides.set(side, kept);
		return Promise.resolve(side);
	}
}
