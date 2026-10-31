// Azure DevOps Boards as a Tracker: a work item's state is never read or set (docs/adr/0002).
import { z } from 'zod';
import { SIGNALS, type Signal, type SignalNames } from '../signals.js';
import type {
	Blocker,
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
import { AzureDevOpsFailure, type AzureDevOpsApi } from './api.js';
import { plainText } from './text.js';

export interface AzureBoardsSettings {
	readonly project: string;
	// the work item type that plays the Feature
	readonly featureType: string;
	// the work item type a Ticket is made as; without one, no Ticket is made
	readonly ticketType?: string | undefined;
}

const API = 'api-version=7.1';
// the Comments endpoint is preview-only
const COMMENTS_API = 'api-version=7.1-preview.4';
// the most ids one read of work items takes
const BATCH = 200;
// One page of 200 is all Nightjar reads: a Feature with more comments is no Feature for one run.
const COMMENTS_PAGE = 200;

const CHILD = 'System.LinkTypes.Hierarchy-Forward';
const PARENT = 'System.LinkTypes.Hierarchy-Reverse';
const PREDECESSOR = 'System.LinkTypes.Dependency-Reverse';
// Set when an item reaches a closed state of the team's process: whether it is closed, without reading the state.
const CLOSED_DATE = 'Microsoft.VSTS.Common.ClosedDate';

const ItemSchema = z.looseObject({
	id: z.int(),
	fields: z.record(z.string(), z.unknown()),
	relations: z.array(z.looseObject({ rel: z.string(), url: z.string() })).nullish(),
	multilineFieldsFormat: z.record(z.string(), z.string()).nullish()
});

type Item = z.infer<typeof ItemSchema>;

const ItemsSchema = z.looseObject({ value: z.array(ItemSchema.nullable()) });

const WiqlSchema = z.looseObject({ workItems: z.array(z.looseObject({ id: z.int() })) });

const ConnectionSchema = z.looseObject({
	authenticatedUser: z.looseObject({
		id: z.string(),
		properties: z.looseObject({ Account: z.looseObject({ $value: z.string().min(1) }) })
	})
});

const IdentityRefSchema = z.looseObject({
	id: z.string().nullish(),
	uniqueName: z.string().nullish(),
	displayName: z.string().nullish()
});

const CommentsSchema = z.looseObject({
	comments: z.array(
		z.looseObject({
			text: z.string().nullish(),
			format: z.string().nullish(),
			createdBy: IdentityRefSchema.nullish(),
			createdDate: z.string()
		})
	)
});

const IdentitiesSchema = z.looseObject({
	value: z.array(
		z
			.looseObject({
				descriptor: z.string().nullish(),
				memberOf: z.array(z.string()).nullish()
			})
			.nullable()
	)
});

// The work item number an id names; Azure DevOps has no other kind of id.
export function workItem(id: ItemId): number {
	if (!/^\d+$/.test(id)) throw new AzureDevOpsFailure(`${id} is no Azure DevOps work item number.`);
	return Number(id);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

// The tags of a work item, as `System.Tags` holds them: "a; b".
const tagsOf = (item: Item): string[] =>
	text(item.fields['System.Tags'])
		.split(';')
		.map((t) => t.trim())
		.filter((t) => t !== '');

// Azure DevOps keeps tags without regard to case.
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// The id a link names, from its address .../_apis/wit/workItems/<id>.
const linked = (item: Item, rel: string): number[] =>
	(item.relations ?? []).flatMap((r) => {
		const id = r.rel === rel ? /\/workItems\/(\d+)$/i.exec(r.url)?.[1] : undefined;
		return id === undefined ? [] : [Number(id)];
	});

// A team's process ranks its backlog by one of these; an item no one has ordered has neither.
const RANKS = ['Microsoft.VSTS.Common.StackRank', 'Microsoft.VSTS.Common.BacklogPriority'];

const rankOf = (item: Item): number => {
	for (const field of RANKS) {
		const value = item.fields[field];
		if (typeof value === 'number') return value;
	}
	return Infinity;
};

const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;

// One answer per key, read once and kept; a read that failed is forgotten, so the next asks again.
function kept<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
	const known = new Map<string, Promise<T>>();
	return (key) => {
		let got = known.get(key);
		if (got === undefined) {
			got = read(key);
			known.set(key, got);
			got.catch(() => known.delete(key));
		}
		return got;
	};
}

export class AzureBoardsTracker implements Tracker, FeatureWriter {
	private readonly project: string;
	private readonly signedIn = kept(() =>
		this.api
			.parse(
				'read the signed-in person',
				{ method: 'GET', url: this.api.at(`_apis/connectionData?${API}-preview`) },
				ConnectionSchema
			)
			.then((c) => ({
				name: c.authenticatedUser.properties.Account.$value,
				id: c.authenticatedUser.id
			}))
	);
	private readonly contributors = kept(() => this.contributorsGroup());
	private readonly members = kept((id) => this.isContributor(id));

	constructor(
		private readonly api: AzureDevOpsApi,
		private readonly settings: AzureBoardsSettings,
		private readonly names: SignalNames,
		// factory.json's trusted list; when set it replaces the Contributors default
		private readonly trusted?: readonly string[]
	) {
		this.project = encodeURIComponent(settings.project);
	}

	private signalsOf(item: Item): Signal[] {
		const tags = tagsOf(item);
		return SIGNALS.filter((s) => tags.some((t) => same(t, this.names[s])));
	}

	private body(item: Item): string {
		const format = item.multilineFieldsFormat?.['System.Description'];
		return plainText(text(item.fields['System.Description']), format);
	}

	private toFeature(item: Item): Feature {
		return { id: String(item.id), title: text(item.fields['System.Title']), body: this.body(item) };
	}

	async me(): Promise<string> {
		return (await this.signedIn('')).name;
	}

	// The work items with these ids, each with its fields and links; `omit` leaves out one that cannot be read.
	private async items(ids: readonly number[], omit: boolean): Promise<Item[]> {
		const out: Item[] = [];
		for (let at = 0; at < ids.length; at += BATCH) {
			const batch = ids.slice(at, at + BATCH);
			const policy = omit ? '&errorPolicy=omit' : '';
			const got = await this.api.parse(
				`read work items ${batch.join(', ')}`,
				{
					method: 'GET',
					url: this.api.at(
						`_apis/wit/workitems?ids=${batch.join(',')}&$expand=relations${policy}&${API}`
					)
				},
				ItemsSchema
			);
			out.push(...got.value.filter((i) => i !== null));
		}
		return out;
	}

	private async item(id: number): Promise<Item> {
		const [found] = await this.items([id], false);
		if (found === undefined) {
			throw new AzureDevOpsFailure(`Azure DevOps answered no work item ${String(id)}.`);
		}
		return found;
	}

	async assignedFeatures(person: string): Promise<Feature[]> {
		// @Me matches the signed-in person however the directory spells their name
		const assignee = same(person, await this.me()) ? '@Me' : quoted(person);
		const query =
			'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project' +
			` AND [System.WorkItemType] = ${quoted(this.settings.featureType)}` +
			` AND [System.AssignedTo] = ${assignee}` +
			` AND [System.Tags] CONTAINS ${quoted(this.names.go)}` +
			' ORDER BY [System.Id]';
		const found = await this.api.parse(
			'find the Features assigned with the Go',
			{
				method: 'POST',
				url: this.api.at(`${this.project}/_apis/wit/wiql?${API}`),
				body: { query }
			},
			WiqlSchema
		);
		const items = await this.items(
			found.workItems.map((w) => w.id),
			true
		);
		return items
			.filter(
				(i) =>
					i.fields[CLOSED_DATE] === undefined &&
					linked(i, CHILD).length > 0 &&
					this.signalsOf(i).includes('go')
			)
			.sort((a, b) => a.id - b.id)
			.map((i) => this.toFeature(i));
	}

	async feature(id: ItemId): Promise<Feature> {
		return this.toFeature(await this.item(workItem(id)));
	}

	async standing(id: ItemId): Promise<Standing> {
		const item = await this.item(workItem(id));
		const assigned = IdentityRefSchema.safeParse(item.fields['System.AssignedTo']);
		const me = await this.signedIn('');
		const name = !assigned.success
			? null
			: assigned.data.id === me.id
				? me.name
				: (assigned.data.uniqueName ?? assigned.data.displayName ?? null);
		return { assignees: name === null ? [] : [name], signals: this.signalsOf(item) };
	}

	async tickets(featureId: ItemId): Promise<Ticket[]> {
		const order = linked(await this.item(workItem(featureId)), CHILD);
		const children = await this.items(order, true);
		const byId = new Map(children.map((c) => [c.id, c]));
		const outside = [
			...new Set(children.flatMap((c) => linked(c, PREDECESSOR)).filter((id) => !byId.has(id)))
		];
		const others = new Map((await this.items(outside, true)).map((i) => [i.id, i]));
		const blockers = (child: Item): Blocker[] =>
			linked(child, PREDECESSOR).flatMap((id) => {
				const found = byId.get(id) ?? others.get(id);
				return found ? [{ id: String(id), open: found.fields[CLOSED_DATE] === undefined }] : [];
			});
		// the backlog's order, and the order of the links where the backlog has none
		const ranked = children
			.map((child) => ({ child, rank: rankOf(child), at: order.indexOf(child.id) }))
			.sort((a, b) => a.rank - b.rank || a.at - b.at)
			.map((r) => r.child);
		return ranked.map((child) => ({
			id: String(child.id),
			title: text(child.fields['System.Title']),
			body: this.body(child),
			open: child.fields[CLOSED_DATE] === undefined,
			signals: this.signalsOf(child),
			blockedBy: blockers(child)
		}));
	}

	async comments(id: ItemId): Promise<Comment[]> {
		const n = String(workItem(id));
		const got = await this.api.parse(
			`read the comments on work item ${n}`,
			{
				method: 'GET',
				url: this.api.at(
					`${this.project}/_apis/wit/workItems/${n}/comments?$top=${String(COMMENTS_PAGE)}&order=asc&${COMMENTS_API}`
				)
			},
			CommentsSchema
		);
		const me = await this.signedIn('');
		const comments: Comment[] = [];
		const oldestFirst = [...got.comments].sort((a, b) =>
			a.createdDate < b.createdDate ? -1 : a.createdDate > b.createdDate ? 1 : 0
		);
		for (const c of oldestFirst) {
			const by = c.createdBy;
			// the signed-in person goes by the name me() gives, however the comment spells it
			const author = by?.id === me.id ? me.name : (by?.uniqueName ?? by?.displayName ?? '');
			comments.push({
				author,
				body: plainText(c.text ?? '', c.format),
				at: c.createdDate,
				trusted: await this.isTrusted(author, by?.id ?? null)
			});
		}
		return comments;
	}

	// Whether a comment's author is trusted: on the configured list, else in the project's Contributors group.
	private async isTrusted(author: string, id: string | null): Promise<boolean> {
		if (this.trusted !== undefined) return this.trusted.some((t) => same(t, author));
		return id === null ? false : this.members(id);
	}

	private async isContributor(id: string): Promise<boolean> {
		const group = await this.contributors('');
		const got = await this.api.parse(
			`read the groups of ${id}`,
			{
				method: 'GET',
				url: this.api.identities(
					`_apis/identities?identityIds=${encodeURIComponent(id)}&queryMembership=ExpandedUp&${API}`
				)
			},
			IdentitiesSchema
		);
		return (got.value[0]?.memberOf ?? []).some((d) => same(d, group));
	}

	// The descriptor of the project's Contributors group, which every member of the project's teams is in.
	private async contributorsGroup(): Promise<string> {
		const name = `[${this.settings.project}]\\Contributors`;
		const got = await this.api.parse(
			`find the group ${name}`,
			{
				method: 'GET',
				url: this.api.identities(
					`_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(name)}&queryMembership=None&${API}`
				)
			},
			IdentitiesSchema
		);
		const descriptor = got.value[0]?.descriptor;
		if (!descriptor) throw new AzureDevOpsFailure(`Azure DevOps has no group ${name}.`);
		return descriptor;
	}

	// Tags are one field, so a change writes the whole list back.
	private async setTags(id: ItemId, change: (tags: string[]) => string[] | null): Promise<void> {
		const n = String(workItem(id));
		const tags = change(tagsOf(await this.item(workItem(id))));
		if (tags === null) return;
		await this.api.call(`tag work item ${n}`, {
			method: 'PATCH',
			url: this.api.at(`${this.project}/_apis/wit/workitems/${n}?${API}`),
			body: [{ op: 'add', path: '/fields/System.Tags', value: tags.join('; ') }],
			contentType: 'application/json-patch+json'
		});
	}

	addSignal(id: ItemId, signal: Signal): Promise<void> {
		const tag = this.names[signal];
		return this.setTags(id, (tags) => (tags.some((t) => same(t, tag)) ? null : [...tags, tag]));
	}

	removeSignal(id: ItemId, signal: Signal): Promise<void> {
		const tag = this.names[signal];
		return this.setTags(id, (tags) =>
			tags.some((t) => same(t, tag)) ? tags.filter((t) => !same(t, tag)) : null
		);
	}

	async comment(id: ItemId, body: string): Promise<void> {
		const n = String(workItem(id));
		await this.api.call(`comment on work item ${n}`, {
			method: 'POST',
			url: this.api.at(
				`${this.project}/_apis/wit/workItems/${n}/comments?format=markdown&${COMMENTS_API}`
			),
			body: { text: body }
		});
	}

	reference(id: ItemId): TicketReference {
		return { id, text: `AB#${String(workItem(id))}` };
	}

	// A work item of `type` whose Description is Markdown, so a Ticket's lines read back as written.
	private async create(type: string, item: ItemText, links: readonly unknown[]): Promise<ItemId> {
		const made = await this.api.parse(
			`make the ${type} ${item.title}`,
			{
				method: 'POST',
				url: this.api.at(`${this.project}/_apis/wit/workitems/$${encodeURIComponent(type)}?${API}`),
				body: [
					{ op: 'add', path: '/fields/System.Title', value: item.title },
					{ op: 'add', path: '/fields/System.Description', value: item.body },
					{ op: 'add', path: '/multilineFieldsFormat/System.Description', value: 'Markdown' },
					...links.map((value) => ({ op: 'add', path: '/relations/-', value }))
				],
				contentType: 'application/json-patch+json'
			},
			ItemSchema
		);
		return String(made.id);
	}

	private link(rel: string, id: ItemId) {
		return { rel, url: this.api.at(`_apis/wit/workItems/${String(workItem(id))}`) };
	}

	createFeature(feature: ItemText): Promise<ItemId> {
		return this.create(this.settings.featureType, feature, []);
	}

	createTicket(featureId: ItemId, ticket: ItemText): Promise<ItemId> {
		const type = this.settings.ticketType;
		if (type === undefined) {
			return Promise.reject(
				new AzureDevOpsFailure('Name the work item type of a Ticket as tracker.ticketType.')
			);
		}
		return this.create(type, ticket, [this.link(PARENT, featureId)]);
	}

	async block(id: ItemId, blocker: ItemId): Promise<void> {
		const n = String(workItem(id));
		await this.api.call(`link work item ${n} after ${blocker}`, {
			method: 'PATCH',
			url: this.api.at(`${this.project}/_apis/wit/workitems/${n}?${API}`),
			body: [{ op: 'add', path: '/relations/-', value: this.link(PREDECESSOR, blocker) }],
			contentType: 'application/json-patch+json'
		});
	}
}
