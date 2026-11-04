// A Code host kept in memory, for the build loop's specs and for anyone testing against the seam.
import type { CodeHost, DraftRequest, NightjarDraft, Pull, PullChecks } from '../code-host.js';
import type { TicketReference } from '../tracker.js';
import { BRANCH_PREFIX } from '../worktree.js';

export interface FakePull extends Pull, DraftRequest {
	// false once a person marks it ready for review
	readonly draft: boolean;
	// false once it is closed or merged
	readonly open: boolean;
	readonly references: readonly TicketReference[];
	// the comments Nightjar left
	readonly comments: readonly string[];
	// the Pull checks on its head commit; none until a spec sets them
	readonly checks: PullChecks;
	// whether a person other than Nightjar reviewed or commented on it
	readonly personEngaged: boolean;
}

const NO_CHECKS: PullChecks = { pending: false, failed: [] };

export class FakeCodeHost implements CodeHost {
	readonly pushes: { readonly folder: string; readonly branch: string }[] = [];
	pulls: FakePull[] = [];
	// what the fake calls the commit a push from `folder` puts on a branch; a harness that names its commits sets it
	commitAt = (folder: string, push: number): string => `${folder}@${String(push)}`;
	// the commit each branch points at
	private readonly heads = new Map<string, string>();

	private change(id: number, over: (p: FakePull) => Partial<FakePull>) {
		const known = this.pulls.some((p) => p.id === id);
		if (!known) throw new Error(`the fake Code host has no pull request ${String(id)}`);
		this.pulls = this.pulls.map((p) => (p.id === id ? { ...p, ...over(p) } : p));
	}

	// a new head commit has its Pull checks queued, as a real Code host starts them on a push
	push = (folder: string, branch: string): Promise<void> => {
		this.pushes.push({ folder, branch });
		this.heads.set(branch, this.commitAt(folder, this.pushes.length));
		const queued = (p: FakePull): FakePull => ({ ...p, checks: { pending: true, failed: [] } });
		this.pulls = this.pulls.map((p) => (p.open && p.head === branch ? queued(p) : p));
		return Promise.resolve();
	};

	openPull = (branch: string): Promise<Pull | null> => {
		const found = this.pulls.find((p) => p.open && p.head === branch);
		return Promise.resolve(found ? { id: found.id, url: found.url } : null);
	};

	createDraft = (request: DraftRequest): Promise<Pull> => {
		const id = 100 + this.pulls.length;
		const url = `https://code.example/pull/${String(id)}`;
		this.pulls.push({
			...request,
			id,
			url,
			draft: true,
			open: true,
			references: [],
			comments: [],
			checks: NO_CHECKS,
			personEngaged: false
		});
		return Promise.resolve({ id, url });
	};

	editBody = (pull: Pull, body: string): Promise<void> => {
		this.change(pull.id, () => ({ body }));
		return Promise.resolve();
	};

	placeReferences = (pull: Pull, references: readonly TicketReference[]): Promise<void> => {
		this.change(pull.id, (p) => ({
			references: [
				...p.references,
				...references.filter((r) => !p.references.some((q) => q.id === r.id))
			]
		}));
		return Promise.resolve();
	};

	comment = (pull: Pull, body: string): Promise<void> => {
		this.change(pull.id, (p) => ({ comments: [...p.comments, body] }));
		return Promise.resolve();
	};

	// in the order they were opened, which is the order of their ids
	nightjarDrafts = (): Promise<NightjarDraft[]> => {
		const drafts = this.pulls.filter((p) => p.open && p.draft && p.head.startsWith(BRANCH_PREFIX));
		const listed = drafts.map((p): NightjarDraft => ({
			pull: { id: p.id, url: p.url },
			branch: p.head,
			headCommit: this.heads.get(p.head) ?? '',
			body: p.body,
			checks: p.checks,
			personEngaged: p.personEngaged
		}));
		return Promise.resolve(listed);
	};

	// What the Code host's own runs and a person do to a pull request, which a spec plays.

	// the Pull checks on the pull request's head commit
	setChecks(pull: Pull, checks: PullChecks): void {
		this.change(pull.id, () => ({ checks }));
	}

	// a person other than Nightjar reviews or comments
	engage(pull: Pull): void {
		this.change(pull.id, () => ({ personEngaged: true }));
	}

	markReady(pull: Pull): void {
		this.change(pull.id, () => ({ draft: false }));
	}

	close(pull: Pull): void {
		this.change(pull.id, () => ({ open: false }));
	}
}
