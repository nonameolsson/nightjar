// A Tracker kept in memory, for the build loop's specs and for anyone testing against the seam.
import type { Signal } from '../signals.js';
import type { Comment, Feature, Ticket, TicketReference, Tracker } from '../tracker.js';

export interface FakeItem {
	readonly id: number;
	readonly title: string;
	readonly body: string;
	readonly open: boolean;
	readonly assignees: readonly string[];
	readonly signals: readonly Signal[];
	// its Tickets, in its own order; an item with none is no Feature
	readonly children: readonly number[];
	readonly blockedBy: readonly number[];
	readonly comments: readonly Comment[];
}

export type NewItem = Pick<FakeItem, 'id' | 'title'> & Partial<FakeItem>;

export class FakeTracker implements Tracker {
	readonly items = new Map<number, FakeItem>();

	constructor(
		// the signed-in person, whose comments are trusted
		readonly person = 'ann',
		private readonly now: () => Date = () => new Date()
	) {}

	add(item: NewItem): this {
		this.items.set(item.id, {
			body: `The body of ${item.title}.`,
			open: true,
			assignees: [],
			signals: [],
			children: [],
			blockedBy: [],
			comments: [],
			...item
		});
		return this;
	}

	// A comment by anyone, trusted or not.
	say(id: number, comment: Omit<Comment, 'at'> & Partial<Pick<Comment, 'at'>>): this {
		const item = this.get(id);
		const at = comment.at ?? this.now().toISOString();
		this.items.set(id, { ...item, comments: [...item.comments, { ...comment, at }] });
		return this;
	}

	close(id: number): this {
		this.items.set(id, { ...this.get(id), open: false });
		return this;
	}

	signalsOf = (id: number): readonly Signal[] => this.get(id).signals;

	said = (id: number): string[] => this.get(id).comments.map((c) => c.body);

	private get(id: number): FakeItem {
		const item = this.items.get(id);
		if (item === undefined) throw new Error(`the fake Tracker has no item #${String(id)}`);
		return item;
	}

	me = () => Promise.resolve(this.person);

	assignedFeatures = (person: string): Promise<Feature[]> =>
		Promise.resolve(
			[...this.items.values()]
				.filter(
					(i) =>
						i.open &&
						i.children.length > 0 &&
						i.assignees.includes(person) &&
						i.signals.includes('go')
				)
				.sort((a, b) => a.id - b.id)
				.map(({ id, title, body }) => ({ id, title, body }))
		);

	feature = (id: number): Promise<Feature> => {
		const { title, body } = this.get(id);
		return Promise.resolve({ id, title, body });
	};

	tickets = (featureId: number): Promise<Ticket[]> =>
		Promise.resolve(
			this.get(featureId).children.map((child) => {
				const t = this.get(child);
				return {
					id: t.id,
					title: t.title,
					body: t.body,
					open: t.open,
					signals: t.signals,
					blockedBy: t.blockedBy.map((b) => ({ id: b, open: this.items.get(b)?.open ?? true }))
				};
			})
		);

	comments = (id: number): Promise<Comment[]> => Promise.resolve([...this.get(id).comments]);

	addSignal = (id: number, signal: Signal): Promise<void> => {
		const item = this.get(id);
		if (!item.signals.includes(signal)) {
			this.items.set(id, { ...item, signals: [...item.signals, signal] });
		}
		return Promise.resolve();
	};

	removeSignal = (id: number, signal: Signal): Promise<void> => {
		const item = this.get(id);
		this.items.set(id, { ...item, signals: item.signals.filter((s) => s !== signal) });
		return Promise.resolve();
	};

	comment = (id: number, body: string): Promise<void> => {
		this.say(id, { author: this.person, body, trusted: true });
		return Promise.resolve();
	};

	reference = (id: number): TicketReference => ({ id, text: `#${String(id)}` });
}
