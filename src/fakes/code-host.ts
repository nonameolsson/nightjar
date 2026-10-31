// A Code host kept in memory, for the build loop's specs and for anyone testing against the seam.
import type { CodeHost, DraftRequest, Pull } from '../code-host.js';
import type { TicketReference } from '../tracker.js';

export interface FakePull extends Pull, DraftRequest {
	readonly draft: true;
	readonly references: readonly TicketReference[];
	readonly comments: readonly string[];
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
		this.pulls.push({ ...request, id, url, draft: true, references: [], comments: [] });
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
}
