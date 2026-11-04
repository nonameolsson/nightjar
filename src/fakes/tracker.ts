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
	TicketCount,
	TicketReference,
	Tracker
} from '../tracker.js';
import { sourcedFrom, waitingFrom, type SourcedFeature, type WaitingFeature } from '../tracker.js';

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
	// when it was made, as an ISO date; left out, the order it was added in says
	readonly at?: string;
}

export type NewItem = Pick<FakeItem, 'id' | 'title'> & Partial<FakeItem>;

export class FakeTracker implements Tracker, FeatureWriter {
	readonly items = new Map<ItemId, FakeItem>();
	// the people it trusts besides the signed-in person
	private readonly trustedPeople = new Set<string>();

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

	// People it trusts, as write access does on GitHub.
	trust(...people: readonly string[]): this {
		for (const person of people) this.trustedPeople.add(person);
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

	waitingOn = (person: string): Promise<WaitingFeature[]> =>
		waitingFrom((signal) =>
			Promise.resolve(
				[...this.items.values()]
					.filter(
						(i) =>
							i.open &&
							i.children.length > 0 &&
							i.assignees.includes(person) &&
							i.signals.includes(signal)
					)
					.map(({ id, title, body }) => ({ id, title, body }))
			)
		);

	// each item is taken as made a minute after the one added before it, unless it says when
	featuresFrom = (source: string): Promise<SourcedFeature[]> =>
		Promise.resolve(
			sourcedFrom(
				source,
				[...this.items.values()].map((item, i) => ({
					id: item.id,
					body: item.body,
					open: item.open,
					at: item.at ?? new Date(Date.UTC(2026, 9, 30, 8, i + 1)).toISOString()
				}))
			)
		);

	ticketCounts = (ids: readonly ItemId[]): Promise<Map<ItemId, TicketCount | null>> =>
		Promise.resolve(
			new Map(
				ids.map((id) => {
					const item = this.items.get(id);
					if (item === undefined) return [id, null];
					const closed = item.children.filter((c) => this.items.get(c)?.open === false).length;
					return [id, { total: item.children.length, closed }];
				})
			)
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

	assign = (id: ItemId, person: string): Promise<void> => {
		const item = this.get(id);
		if (!item.assignees.includes(person)) {
			this.items.set(id, { ...item, assignees: [...item.assignees, person] });
		}
		return Promise.resolve();
	};

	trusts = (person: string): Promise<boolean> =>
		Promise.resolve(person === this.person || this.trustedPeople.has(person));

	createFeature = ({ title, body }: ItemText): Promise<ItemId> => {
		let n = this.items.size + 1;
		while (this.items.has(`${this.prefix}${String(n)}`)) n += 1;
		const id = `${this.prefix}${String(n)}`;
		this.add({ id, title, body, at: this.now().toISOString() });
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
