// A Code host kept in memory, for the build loop's specs and for anyone testing against the seam.
import { failedCheckBody } from '../check-output.js';
import type {
	ChangeRequest,
	CodeHost,
	DraftRequest,
	Feedback,
	OpenPull,
	Pull
} from '../code-host.js';
import { answerText, endsWithFooter, withFooter } from '../footer.js';
import type { TicketReference } from '../tracker.js';

export interface FakePull extends Pull, DraftRequest {
	readonly draft: true;
	readonly references: readonly TicketReference[];
	readonly comments: readonly string[];
	readonly openedAt: string;
	readonly changesRequested: readonly ChangeRequest[];
}

export class FakeCodeHost implements CodeHost {
	readonly pushes: { readonly folder: string; readonly branch: string }[] = [];
	pulls: FakePull[] = [];

	private change(id: number, over: (p: FakePull) => Partial<FakePull>) {
		const known = this.pulls.some((p) => p.id === id);
		if (!known) throw new Error(`the fake Code host has no pull request ${String(id)}`);
		this.pulls = this.pulls.map((p) => (p.id === id ? { ...p, ...over(p) } : p));
	}

	push = (folder: string, branch: string): Promise<void> => {
		this.pushes.push({ folder, branch });
		return Promise.resolve();
	};

	openPull = (branch: string): Promise<Pull | null> => {
		const found = this.pulls.find((p) => p.head === branch);
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
			references: [],
			comments: [],
			// at the minute of the last thing said, so whatever is said on it comes after
			openedAt: this.clock(this.lastId),
			changesRequested: []
		});
		return Promise.resolve({ id, url });
	};

	openPulls = (prefix: string): Promise<OpenPull[]> =>
		Promise.resolve(
			this.pulls
				.filter((p) => p.head.startsWith(prefix))
				.map((p) => ({
					id: p.id,
					url: p.url,
					branch: p.head,
					openedAt: p.openedAt,
					changesRequested: p.changesRequested
				}))
		);

	// A review by `author` that requests changes, at the next minute; with a body it is feedback too, whose id it gives, else null.
	requestChanges = (
		pull: Pull,
		review: { author: string; trusted: boolean; body?: string }
	): string | null => {
		const { author, trusted, body = '' } = review;
		const id = body === '' ? null : this.give(pull, { kind: 'review', author, trusted, body });
		if (id === null) this.lastId += 1;
		const request = { author, trusted, at: this.clock(this.lastId) };
		this.change(pull.id, (p) => ({ changesRequested: [...p.changesRequested, request] }));
		return id;
	};

	private readonly clock = (minute: number) =>
		new Date(Date.UTC(2026, 9, 31, 0, minute)).toISOString();

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

	// the feedback of each pull request, by its id, as people and checks gave it
	private readonly given = new Map<number, Feedback[]>();
	// the replies in the thread of each line comment, by pull request and feedback id
	readonly threads: { readonly pull: number; readonly id: string; readonly body: string }[] = [];
	private lastId = 0;

	// Puts feedback on a pull request, with the next id of its kind; a comment in the conversation shows there too.
	give = (pull: Pull, feedback: Omit<Feedback, 'id' | 'at'>): string => {
		this.lastId += 1;
		const id = `${feedback.kind}:${String(this.lastId)}`;
		const at = new Date(Date.UTC(2026, 9, 31, 0, this.lastId)).toISOString();
		this.given.set(pull.id, [...(this.given.get(pull.id) ?? []), { ...feedback, id, at }]);
		if (feedback.kind === 'comment' && feedback.path === undefined) {
			this.change(pull.id, (p) => ({ comments: [...p.comments, feedback.body] }));
		}
		return id;
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
		const posted = answered.path === undefined ? answerText(answered.body, body) : withFooter(body);
		if (answered.path === undefined) {
			this.change(pull.id, (p) => ({ comments: [...p.comments, posted] }));
		} else {
			this.threads.push({ pull: pull.id, id: feedbackId, body: posted });
		}
		// as on a real host, the reply is a comment of its own, by the signed-in person, whom the host trusts
		this.lastId += 1;
		const own: Feedback = {
			id: `comment:${String(this.lastId)}`,
			kind: 'comment',
			author: 'you',
			body: posted,
			at: new Date(Date.UTC(2026, 9, 31, 0, this.lastId)).toISOString(),
			trusted: true,
			...(answered.path === undefined ? {} : { path: answered.path }),
			...(answered.line === undefined ? {} : { line: answered.line }),
			...(answered.outdated === true ? { outdated: true } : {})
		};
		this.given.set(pull.id, [...(this.given.get(pull.id) ?? []), own]);
		return Promise.resolve();
	};
}
