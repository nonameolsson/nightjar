// A Tracker kept in memory, for the build loop's specs and for anyone testing against the seam.
import type { Signal } from '../signals.js';
import type {
	Comment,
	Feature,
	FeatureWriter,
	ItemId,
	ItemText,
	Standing,
	Ticket,
	TicketReference,
	Tracker
} from '../tracker.js';

export interface FakeItem {
	readonly id: ItemId;
	readonly title: string;
	readonly body: string;
	readonly open: boolean;
	readonly assignees: readonly string[];
	readonly signals: readonly Signal[];
	// its Tickets, in its own order; an item with none is no Feature
	readonly children: readonly ItemId[];
	readonly blockedBy: readonly ItemId[];
	readonly comments: readonly Comment[];
}

export type NewItem = Pick<FakeItem, 'id' | 'title'> & Partial<FakeItem>;

export class FakeTracker implements Tracker, FeatureWriter {
	readonly items = new Map<ItemId, FakeItem>();

	constructor(
		// the signed-in person, whose comments are trusted
		readonly person = 'ann',
		private readonly now: () => Date = () => new Date(),
		// what the ids it makes start with, such as PROJ- for keys as Jira spells them
		private readonly prefix = ''
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
	say(id: ItemId, comment: Omit<Comment, 'at'> & Partial<Pick<Comment, 'at'>>): this {
		const item = this.get(id);
		const at = comment.at ?? this.now().toISOString();
		this.items.set(id, { ...item, comments: [...item.comments, { ...comment, at }] });
		return this;
	}

	close(id: ItemId): this {
		this.items.set(id, { ...this.get(id), open: false });
		return this;
	}

	signalsOf = (id: ItemId): readonly Signal[] => this.get(id).signals;

	said = (id: ItemId): string[] => this.get(id).comments.map((c) => c.body);

	private get(id: ItemId): FakeItem {
		const item = this.items.get(id);
		if (item === undefined) throw new Error(`the fake Tracker has no item #${id}`);
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
				// the fake counts a lower id as older, PROJ-2 before PROJ-10
				.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
				.map(({ id, title, body }) => ({ id, title, body }))
		);

	feature = (id: ItemId): Promise<Feature> => {
		const { title, body } = this.get(id);
		return Promise.resolve({ id, title, body });
	};

	standing = (id: ItemId): Promise<Standing> => {
		const { assignees, signals } = this.get(id);
		return Promise.resolve({ assignees, signals });
	};

	tickets = (featureId: ItemId): Promise<Ticket[]> =>
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

	comments = (id: ItemId): Promise<Comment[]> => Promise.resolve([...this.get(id).comments]);

	addSignal = (id: ItemId, signal: Signal): Promise<void> => {
		const item = this.get(id);
		if (!item.signals.includes(signal)) {
			this.items.set(id, { ...item, signals: [...item.signals, signal] });
		}
		return Promise.resolve();
	};

	removeSignal = (id: ItemId, signal: Signal): Promise<void> => {
		const item = this.get(id);
		this.items.set(id, { ...item, signals: item.signals.filter((s) => s !== signal) });
		return Promise.resolve();
	};

	comment = (id: ItemId, body: string): Promise<void> => {
		this.say(id, { author: this.person, body, trusted: true });
		return Promise.resolve();
	};

	reference = (id: ItemId): TicketReference => ({ id, text: `#${id}` });

	createFeature = ({ title, body }: ItemText): Promise<ItemId> => {
		let n = this.items.size + 1;
		while (this.items.has(`${this.prefix}${String(n)}`)) n += 1;
		const id = `${this.prefix}${String(n)}`;
		this.add({ id, title, body });
		return Promise.resolve(id);
	};

	createTicket = async (featureId: ItemId, ticket: ItemText): Promise<ItemId> => {
		const feature = this.get(featureId);
		const id = await this.createFeature(ticket);
		this.items.set(featureId, { ...feature, children: [...feature.children, id] });
		return id;
	};

	block = (id: ItemId, blocker: ItemId): Promise<void> => {
		const item = this.get(id);
		this.get(blocker);
		if (!item.blockedBy.includes(blocker)) {
			this.items.set(id, { ...item, blockedBy: [...item.blockedBy, blocker] });
		}
		return Promise.resolve();
	};
}
