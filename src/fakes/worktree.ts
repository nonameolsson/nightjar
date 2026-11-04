// The worktree's in-memory adapter, which the build loop's specs run over in place of real git: a branch is a list of commits, and what a Session leaves is files written to it.
import {
	PULL_FIX_TRAILER,
	attemptBranch,
	folderFor,
	pullFixCommitMessage,
	stepCommitMessage,
	ticketCommitMessage,
	trailersOf,
	type FeatureBranch,
	type OpenWorktree,
	type StepCommit,
	type Worktree
} from '../worktree.js';

interface Commit {
	readonly message: string;
	readonly files: ReadonlyMap<string, string>;
	// what its trailer names, if it has one
	readonly ticket?: string;
	readonly step?: string;
}

interface Folder {
	commits: Commit[];
	// what is written and not yet committed
	dirty: Map<string, string>;
	setUp: boolean;
}

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
}

export function memoryWorktrees(): MemoryWorktrees {
	const folders = new Map<string, Folder>();
	const sides = new Map<string, string[]>();
	const state = (folder: string): Folder => {
		let got = folders.get(folder);
		if (got === undefined) {
			got = { commits: [], dirty: new Map(), setUp: false };
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
		// a worktree a stopped run left dirty is cleaned, as the real one is
		state(at.folder).dirty.clear();
		return Promise.resolve(new MemoryWorktree(at, state(at.folder), sides));
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
		}
	};
}

class MemoryWorktree implements Worktree {
	constructor(
		readonly at: FeatureBranch,
		private readonly folder: Folder,
		private readonly sides: Map<string, string[]>
	) {}

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
	}

	revert(before: string) {
		this.reset(before);
		return Promise.resolve();
	}

	// The model has one copy of the branch, which is the remote's too.
	toRemote = () => Promise.resolve(true);

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
