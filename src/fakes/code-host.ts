// A Code host kept in memory, for the build loop's specs and for anyone testing against the seam.
import { failedCheckBody } from '../check-output.js';
import type {
	ChangeRequest,
	CodeHost,
	DraftRequest,
	Feedback,
	NightjarDraft,
	OpenPull,
	Pull,
	PullChecks,
	PullCommit
} from '../code-host.js';
import { answerText, endsWithFooter, withFooter } from '../footer.js';
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
	// the messages of the commits a push from `folder` leaves on a branch, oldest first; a harness that keeps commits sets it
	commitsAt = (_folder: string): readonly string[] => [];
	// the commit each branch points at
	private readonly heads = new Map<string, string>();
	// the commits each branch holds, each dated when a push first brought it
	private readonly branchCommits = new Map<string, readonly PullCommit[]>();

	private change(id: number, over: (p: FakePull) => Partial<FakePull>) {
		const known = this.pulls.some((p) => p.id === id);
		if (!known) throw new Error(`the fake Code host has no pull request ${String(id)}`);
		this.pulls = this.pulls.map((p) => (p.id === id ? { ...p, ...over(p) } : p));
	}

	// a new head commit has its Pull checks queued, as a real Code host starts them on a push
	push = (folder: string, branch: string): Promise<void> => {
		this.pushes.push({ folder, branch });
		this.heads.set(branch, this.commitAt(folder, this.pushes.length));
		this.branchCommits.set(branch, this.dated(branch, this.commitsAt(folder)));
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

	// in the order they were opened, which is the order of their ids
	openPulls = (prefix: string): Promise<OpenPull[]> => {
		const open = this.pulls.filter((p) => p.open && p.head.startsWith(prefix));
		const listed = open.map((p): OpenPull => ({
			pull: { id: p.id, url: p.url },
			branch: p.head,
			body: p.body,
			commits: this.branchCommits.get(p.head) ?? [],
			changesRequested: this.asked.get(p.id) ?? []
		}));
		return Promise.resolve(listed);
	};

	// The branch's commits after a push: those it had keep their dates, while they come first in the same order; the rest are dated now.
	private dated(branch: string, messages: readonly string[]): PullCommit[] {
		const had = this.branchCommits.get(branch) ?? [];
		const out: PullCommit[] = [];
		let same = true;
		for (const [i, message] of messages.entries()) {
			const before = had[i];
			same = same && before?.message === message;
			out.push(same && before !== undefined ? before : { message, at: this.tick() });
		}
		return out;
	}

	// the fake's clock: one minute on for each thing that happens, from 31 October 2026
	private tick(): string {
		this.lastId += 1;
		return new Date(Date.UTC(2026, 9, 31, 0, this.lastId)).toISOString();
	}

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

	// the feedback of each pull request, by its id, as people and checks gave it
	private readonly given = new Map<number, Feedback[]>();
	// the replies in the thread of each line comment, by pull request and feedback id
	readonly threads: { readonly pull: number; readonly id: string; readonly body: string }[] = [];
	private lastId = 0;
	// the reviews that requested changes, by pull request
	private readonly asked = new Map<number, ChangeRequest[]>();

	// Puts feedback on a pull request, with the next id of its kind; a comment in the conversation shows there too, and a review with `changes` requests changes.
	give = (pull: Pull, feedback: Omit<Feedback, 'id' | 'at'>, changes = false): string => {
		const at = this.tick();
		const id = `${feedback.kind}:${String(this.lastId)}`;
		this.given.set(pull.id, [...(this.given.get(pull.id) ?? []), { ...feedback, id, at }]);
		if (feedback.kind === 'comment' && feedback.path === undefined) {
			this.change(pull.id, (p) => ({ comments: [...p.comments, feedback.body] }));
		}
		if (feedback.kind === 'review' && changes) {
			const { author, trusted } = feedback;
			this.asked.set(pull.id, [...(this.asked.get(pull.id) ?? []), { id, author, at, trusted }]);
		}
		return id;
	};

	// A review by `author` that requests changes; gives its id.
	requestChanges = (
		pull: Pull,
		review: { author: string; trusted: boolean; body?: string }
	): string => {
		const { author, trusted, body = 'Please change it.' } = review;
		return this.give(pull, { kind: 'review', author, trusted, body }, true);
	};

	// A failed check by `author`, the app that ran it; its body is its name and the end of its output.
	giveCheck = (
		pull: Pull,
		check: { name: string; output: string; author: string; trusted: boolean }
	): string =>
		this.give(pull, {
			kind: 'check',
			author: check.author,
			trusted: check.trusted,
			body: failedCheckBody(check.name, check.output)
		});

	feedback = (pull: Pull): Promise<Feedback[]> => {
		const said = (f: Feedback) => f.body.trim() !== '' && !endsWithFooter(f.body);
		return Promise.resolve((this.given.get(pull.id) ?? []).filter(said));
	};

	reply = (pull: Pull, feedbackId: string, body: string): Promise<void> => {
		const answered = (this.given.get(pull.id) ?? []).find((f) => f.id === feedbackId);
		if (answered === undefined) {
			return Promise.reject(
				new Error(`the fake Code host has no feedback ${feedbackId} on ${String(pull.id)}`)
			);
		}
		const said = answered.path === undefined ? answerText(answered.body, body) : withFooter(body);
		if (answered.path === undefined) {
			this.change(pull.id, (p) => ({ comments: [...p.comments, said] }));
		} else {
			this.threads.push({ pull: pull.id, id: feedbackId, body: said });
		}
		// a real Code host lists the reply among the comments, as the signed-in person's, so only its footer keeps it out of the feedback
		const at = this.tick();
		const reply: Feedback = {
			id: `comment:${String(this.lastId)}`,
			kind: 'comment',
			author: 'ann',
			body: said,
			at,
			trusted: true,
			...(answered.path === undefined ? {} : { path: answered.path })
		};
		this.given.set(pull.id, [...(this.given.get(pull.id) ?? []), reply]);
		return Promise.resolve();
	};
}
