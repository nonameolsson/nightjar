// A small Azure DevOps in memory behind the request seam, answering as its REST API does: one
// organization and project, its people and their groups, work items with their links and tags, and
// comments. It throws on a call it does not know, and on any call that names a work item's state.
import type { AzureDevOpsCall, AzureDevOpsReply, AzureDevOpsRequest } from './api.js';
import type { AzureDevOpsSignIn } from './sign-in.js';

export interface NewWorkItem {
	readonly type: string;
	readonly title: string;
	// Markdown unless `html` is set; none leaves the field empty
	readonly description?: string;
	readonly html?: boolean;
	readonly assignedTo?: string;
	readonly tags?: readonly string[];
	// Azure DevOps stamps a Closed Date when an item reaches a closed state of the team's process
	readonly closed?: boolean;
	// the state on the team's board, New unless named; Nightjar never reads it
	readonly state?: string;
	// its place in the backlog, as a team's process ranks it; none until someone orders the backlog
	readonly rank?: { readonly field: string; readonly value: number };
}

interface Link {
	readonly rel: string;
	readonly id: number;
}

interface WorkItem {
	readonly id: number;
	readonly rev: number;
	readonly fields: Readonly<Record<string, unknown>>;
	readonly markdown: boolean;
	readonly links: readonly Link[];
}

interface Person {
	readonly id: string;
	readonly uniqueName: string;
	readonly contributor: boolean;
}

interface StoredComment {
	readonly id: number;
	readonly text: string;
	readonly markdown: boolean;
	readonly author: Person;
	readonly createdDate: string;
}

export interface Asked {
	readonly method: AzureDevOpsCall['method'];
	readonly url: string;
	readonly body: unknown;
}

const TOKEN = 'Bearer fake-azure-devops';
const API = '7.1';
const COMMENTS_API = '7.1-preview.4';

const STATE = /System\.State/i;
const CHILD = 'System.LinkTypes.Hierarchy-Forward';
const PARENT = 'System.LinkTypes.Hierarchy-Reverse';
const SUCCESSOR = 'System.LinkTypes.Dependency-Forward';
const PREDECESSOR = 'System.LinkTypes.Dependency-Reverse';

const json = (status: number, body?: unknown): AzureDevOpsReply => ({
	status,
	text: body === undefined ? '' : JSON.stringify(body)
});

const refusal = (status: number, message: string) => json(status, { message, typeKey: 'Fault' });

// What Azure DevOps keeps of Markdown: a bare < or > becomes its entity.
const storedMarkdown = (text: string) => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fault = (message: string) => new Error(`the fake Azure DevOps: ${message}`);

const guid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

export class FakeAzureDevOps {
	private readonly items = new Map<number, WorkItem>();
	private readonly people = new Map<string, Person>();
	private readonly discussion = new Map<number, StoredComment[]>();
	private clock = Date.UTC(2026, 9, 30, 9, 0);
	// every call it answered, in order
	readonly asked: Asked[] = [];
	private readonly faults: { match: RegExp; status: number }[] = [];

	constructor(
		readonly organization: string,
		readonly project: string,
		// the sign-in name the token is for
		readonly person: string
	) {
		this.join(person, { contributor: true });
	}

	// Adds a person to the organization; a Contributor is in the project's Contributors group by way of its team.
	join(uniqueName: string, { contributor }: { contributor: boolean }): void {
		const known = this.people.get(uniqueName.toLowerCase());
		const id = known?.id ?? guid(this.people.size + 1);
		this.people.set(uniqueName.toLowerCase(), { id, uniqueName, contributor });
	}

	// Makes a work item and gives back its id.
	workItem(item: NewWorkItem): number {
		const id = this.items.size + 1;
		const fields: Record<string, unknown> = {
			'System.Id': id,
			'System.TeamProject': this.project,
			'System.WorkItemType': item.type,
			'System.Title': item.title,
			'System.State': item.state ?? 'New',
			'System.CreatedDate': this.tick()
		};
		if (item.description !== undefined) {
			fields['System.Description'] = item.html
				? item.description
				: storedMarkdown(item.description);
		}
		if (item.assignedTo !== undefined) fields['System.AssignedTo'] = this.identity(item.assignedTo);
		if (item.tags !== undefined && item.tags.length > 0)
			fields['System.Tags'] = item.tags.join('; ');
		if (item.closed === true) fields['Microsoft.VSTS.Common.ClosedDate'] = this.tick();
		if (item.rank !== undefined) fields[item.rank.field] = item.rank.value;
		this.items.set(id, { id, rev: 1, fields, markdown: item.html !== true, links: [] });
		return id;
	}

	// Links `child` under `parent`, last among its children.
	addChild(parent: number, child: number): void {
		this.link(parent, CHILD, child);
		this.link(child, PARENT, parent);
	}

	// Links `successor` after `predecessor`: the predecessor blocks it.
	precede(predecessor: number, successor: number): void {
		this.link(predecessor, SUCCESSOR, successor);
		this.link(successor, PREDECESSOR, predecessor);
	}

	say(id: number, author: string, text: string, { html = false } = {}): void {
		this.get(id);
		const list = this.discussion.get(id) ?? [];
		list.push({
			id: list.length + 1,
			text: html ? text : storedMarkdown(text),
			markdown: !html,
			author: this.who(author),
			createdDate: this.tick()
		});
		this.discussion.set(id, list);
	}

	// The tags on a work item, as Azure DevOps lists them.
	tagsOf(id: number): string[] {
		return tagList(this.get(id).fields['System.Tags']);
	}

	// The next call whose address `match` finds answers `status` and changes nothing.
	failNext(match: RegExp, status: number): void {
		this.faults.push({ match, status });
	}

	// A sign-in whose token this fake takes.
	signIn(): AzureDevOpsSignIn {
		return {
			authorization: () => Promise.resolve(TOKEN),
			via: () => Promise.resolve('the fake sign-in'),
			refresh: () => Promise.resolve()
		};
	}

	readonly request: AzureDevOpsRequest = (url, call) => {
		const body = call.body === undefined ? undefined : (JSON.parse(call.body) as unknown);
		if (STATE.test(url) || STATE.test(call.body ?? '')) {
			throw fault(`Nightjar never reads or sets a work item's state (docs/adr/0002): ${url}`);
		}
		this.asked.push({ method: call.method, url, body });
		if (call.headers.Authorization !== TOKEN) return Promise.resolve(json(401));
		const scripted = this.faults.find((f) => f.match.test(url));
		if (scripted !== undefined) {
			this.faults.splice(this.faults.indexOf(scripted), 1);
			return Promise.resolve(refusal(scripted.status, 'the fake Azure DevOps: a scripted fault'));
		}
		return Promise.resolve(this.answer(new URL(url), call, body));
	};

	private answer(url: URL, call: AzureDevOpsCall, body: unknown): AzureDevOpsReply {
		const org = `/${encodeURIComponent(this.organization)}`;
		const project = `${org}/${encodeURIComponent(this.project)}`;
		const path = url.pathname;
		const route = `${call.method} ${url.host}`;
		if (route === 'GET vssps.dev.azure.com' && path === `${org}/_apis/identities`) {
			return this.identities(url.searchParams);
		}
		if (url.host !== 'dev.azure.com') throw fault(`no host ${url.host}`);
		if (call.method === 'GET' && path === `${org}/_apis/connectionData`) {
			const me = this.who(this.person);
			return json(200, {
				authenticatedUser: {
					id: me.id,
					providerDisplayName: me.uniqueName,
					properties: { Account: { $type: 'System.String', $value: me.uniqueName } }
				}
			});
		}
		if (call.method === 'POST' && path === `${project}/_apis/wit/wiql`) {
			this.query(url, { 'api-version': API });
			return this.wiql(body);
		}
		if (call.method === 'GET' && path === `${org}/_apis/wit/workitems`) {
			return this.batch(url.searchParams);
		}
		const one = new RegExp(`^${project}/_apis/wit/workitems/(\\d+)$`).exec(path);
		if (call.method === 'PATCH' && one) {
			this.query(url, { 'api-version': API });
			if (call.headers['Content-Type'] !== 'application/json-patch+json') {
				throw fault('a work item is patched with application/json-patch+json');
			}
			return this.patch(Number(one[1]), body);
		}
		const thread = new RegExp(`^${project}/_apis/wit/workItems/(\\d+)/comments$`).exec(path);
		if (thread) {
			const id = Number(thread[1]);
			if (!this.items.has(id))
				return refusal(404, `TF401232: Work item ${String(id)} does not exist.`);
			if (call.method === 'GET') return this.comments(id, url.searchParams);
			if (call.method === 'POST') return this.addComment(id, url.searchParams, body);
		}
		throw fault(`no route answers ${call.method} ${url.href}`);
	}

	// The query a call carries must be exactly `wanted`, besides the `optional` names.
	private query(url: URL, wanted: Record<string, string>, optional: readonly string[] = []) {
		for (const [name, value] of Object.entries(wanted)) {
			if (url.searchParams.get(name) !== value) throw fault(`${url.href} needs ${name}=${value}`);
		}
		for (const name of url.searchParams.keys()) {
			if (!(name in wanted) && !optional.includes(name))
				throw fault(`${url.href} takes no ${name}`);
		}
	}

	// The clauses Nightjar writes, joined by AND; any other WIQL is a fault, not an empty answer.
	private wiql(body: unknown): AzureDevOpsReply {
		const query = (body as { query?: unknown } | null)?.query;
		if (typeof query !== 'string') throw fault('a WIQL call carries { query }');
		const shape = /^SELECT \[System\.Id\] FROM WorkItems WHERE (.+) ORDER BY \[System\.Id\]$/s.exec(
			query.trim()
		);
		if (!shape) throw fault(`WIQL of a shape not known: ${query}`);
		const clause = /\s*(?:AND\s+)?\[([\w.]+)\]\s+(=|CONTAINS)\s+('(?:[^']|'')*'|@project|@Me)\s*/y;
		const tests: ((item: WorkItem) => boolean)[] = [];
		const where = shape[1] ?? '';
		while (clause.lastIndex < where.length) {
			const at = clause.lastIndex;
			const found = clause.exec(where);
			if (!found) throw fault(`WIQL clause not known at "${where.slice(at)}"`);
			tests.push(this.clause(found[1] ?? '', found[2] ?? '', found[3] ?? ''));
		}
		const ids = [...this.items.values()].filter((i) => tests.every((t) => t(i))).map((i) => i.id);
		return json(200, {
			queryType: 'flat',
			workItems: ids.sort((a, b) => a - b).map((id) => ({ id, url: this.itemUrl(id) }))
		});
	}

	private clause(field: string, op: string, raw: string): (item: WorkItem) => boolean {
		if (raw === '@project') {
			if (field !== 'System.TeamProject' || op !== '=') throw fault(`@project with ${field}`);
			return () => true;
		}
		if (raw === '@Me') {
			if (field !== 'System.AssignedTo' || op !== '=') throw fault(`@Me with ${field}`);
			return this.clause(field, op, `'${this.person.replace(/'/g, "''")}'`);
		}
		const value = raw.slice(1, -1).replace(/''/g, "'").toLowerCase();
		const text = (item: WorkItem) => {
			const got = item.fields[field];
			const shown = typeof got === 'object' && got !== null ? (got as Person).uniqueName : got;
			return typeof shown === 'string' ? shown.toLowerCase() : '';
		};
		if (op === 'CONTAINS' && field === 'System.Tags') {
			return (item) => tagList(item.fields['System.Tags']).some((t) => t.toLowerCase() === value);
		}
		if (op === '=' && ['System.WorkItemType', 'System.AssignedTo'].includes(field)) {
			return (item) => text(item) === value;
		}
		throw fault(`WIQL clause not known: [${field}] ${op} ${raw}`);
	}

	// Azure DevOps refuses $expand beside a field list; errorPolicy=omit puts a null for an id it cannot show.
	private batch(search: URLSearchParams): AzureDevOpsReply {
		const url = new URL(`https://dev.azure.com/?${search.toString()}`);
		this.query(url, { 'api-version': API }, ['ids', '$expand', 'fields', 'errorPolicy']);
		const expand = search.get('$expand');
		const fields = search.get('fields')?.split(',');
		if (expand !== null && fields !== undefined) {
			return refusal(
				400,
				'VS403062: The expand parameter can not be used with the fields parameter.'
			);
		}
		if (expand !== null && expand !== 'relations') throw fault(`$expand=${expand}`);
		const omit = search.get('errorPolicy');
		if (omit !== null && omit !== 'omit') throw fault(`errorPolicy=${omit}`);
		const ids = (search.get('ids') ?? '')
			.split(',')
			.filter((s) => s !== '')
			.map(Number);
		if (ids.length === 0 || ids.length > 200)
			throw fault(`ids takes 1 to 200 ids, not ${String(ids.length)}`);
		const value = [];
		for (const id of ids) {
			const item = this.items.get(id);
			if (item === undefined && omit === null) {
				return refusal(
					404,
					`TF401232: Work item ${String(id)} does not exist, or you do not have permissions to read it.`
				);
			}
			value.push(item === undefined ? null : this.render(item, fields, expand !== null));
		}
		return json(200, { count: value.length, value });
	}

	// Only the tags are Nightjar's to write: any other patch is a fault.
	private patch(id: number, body: unknown): AzureDevOpsReply {
		const item = this.items.get(id);
		if (item === undefined)
			return refusal(404, `TF401232: Work item ${String(id)} does not exist.`);
		if (!Array.isArray(body)) throw fault('a patch is a list of operations');
		const fields = { ...item.fields };
		for (const op of body as { op?: unknown; path?: unknown; value?: unknown }[]) {
			if ((op.op === 'add' || op.op === 'replace') && op.path === '/fields/System.Tags') {
				const tags: string[] = [];
				for (const tag of tagList(op.value)) {
					if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
				}
				if (tags.length === 0) delete fields['System.Tags'];
				else fields['System.Tags'] = tags.join('; ');
			} else {
				throw fault(`a patch Nightjar may not send: ${JSON.stringify(op)}`);
			}
		}
		const changed = { ...item, rev: item.rev + 1, fields };
		this.items.set(id, changed);
		return json(200, this.render(changed, undefined, false));
	}

	// Azure DevOps answers newest first unless asked otherwise, a page at a time.
	private comments(id: number, search: URLSearchParams): AzureDevOpsReply {
		const url = new URL(`https://dev.azure.com/?${search.toString()}`);
		this.query(url, { 'api-version': COMMENTS_API }, ['$top', 'order', 'continuationToken']);
		const all = [...(this.discussion.get(id) ?? [])];
		if (search.get('order') !== 'asc') all.reverse();
		const top = Number(search.get('$top') ?? '200');
		const from = Number(search.get('continuationToken') ?? '0');
		const page = all.slice(from, from + top);
		return json(200, {
			totalCount: all.length,
			count: page.length,
			comments: page.map((c) => this.renderComment(id, c)),
			...(from + top < all.length ? { continuationToken: String(from + top) } : {})
		});
	}

	private addComment(id: number, search: URLSearchParams, body: unknown): AzureDevOpsReply {
		const url = new URL(`https://dev.azure.com/?${search.toString()}`);
		this.query(url, { 'api-version': COMMENTS_API }, ['format']);
		const text = (body as { text?: unknown } | null)?.text;
		if (typeof text !== 'string') throw fault('a comment carries { text }');
		const html = search.get('format') !== 'markdown';
		this.say(id, this.person, text, { html });
		const list = this.discussion.get(id) ?? [];
		const made = list[list.length - 1];
		if (made === undefined) throw fault('the comment was not kept');
		return json(200, this.renderComment(id, made));
	}

	// Two reads of the identity host: the project's Contributors group by name, and a person by id with every group above them.
	private identities(search: URLSearchParams): AzureDevOpsReply {
		const url = new URL(`https://vssps.dev.azure.com/?${search.toString()}`);
		const contributors = `[${this.project}]\\Contributors`;
		if (search.has('searchFilter')) {
			this.query(url, {
				'api-version': API,
				searchFilter: 'General',
				filterValue: contributors,
				queryMembership: 'None'
			});
			return json(200, {
				count: 1,
				value: [
					{
						id: guid(9001),
						descriptor: CONTRIBUTORS,
						providerDisplayName: contributors,
						isContainer: true
					}
				]
			});
		}
		this.query(url, { 'api-version': API, identityIds: search.get('identityIds') ?? '' }, [
			'queryMembership'
		]);
		const ids = (search.get('identityIds') ?? '').split(',');
		const expanded = search.get('queryMembership') === 'ExpandedUp';
		const value = ids.map((id) => {
			const person = [...this.people.values()].find((p) => p.id === id);
			if (person === undefined) return null;
			// a person reaches Contributors through their team's group, so only an expanded read shows it
			const groups = person.contributor ? [TEAM, ...(expanded ? [CONTRIBUTORS] : [])] : [READERS];
			return {
				id: person.id,
				descriptor: `Microsoft.IdentityModel.Claims.ClaimsIdentity;contoso\\${person.uniqueName}`,
				providerDisplayName: person.uniqueName,
				isContainer: false,
				memberOf: groups
			};
		});
		return json(200, { count: value.length, value });
	}

	private render(item: WorkItem, fields: readonly string[] | undefined, relations: boolean) {
		const shown = fields
			? Object.fromEntries(Object.entries(item.fields).filter(([name]) => fields.includes(name)))
			: item.fields;
		return {
			id: item.id,
			rev: item.rev,
			fields: shown,
			...(item.markdown && 'System.Description' in shown
				? { multilineFieldsFormat: { 'System.Description': 'markdown' } }
				: {}),
			...(relations && item.links.length > 0
				? {
						relations: item.links.map((l) => ({
							rel: l.rel,
							url: this.itemUrl(l.id),
							attributes: { isLocked: false, name: l.rel === CHILD ? 'Child' : 'Other' }
						}))
					}
				: {}),
			url: this.itemUrl(item.id)
		};
	}

	private renderComment(workItemId: number, c: StoredComment) {
		const by = {
			id: c.author.id,
			displayName: c.author.uniqueName,
			uniqueName: c.author.uniqueName
		};
		return {
			workItemId,
			id: c.id,
			version: 1,
			text: c.text,
			format: c.markdown ? 'markdown' : 'html',
			createdBy: by,
			createdDate: c.createdDate,
			modifiedBy: by,
			modifiedDate: c.createdDate,
			isDeleted: false
		};
	}

	private identity(uniqueName: string) {
		const p = this.who(uniqueName);
		return { displayName: p.uniqueName, uniqueName: p.uniqueName, id: p.id };
	}

	// A person the organization knows; one it does not yet is added without Contributors.
	private who(uniqueName: string): Person {
		const found = this.people.get(uniqueName.toLowerCase());
		if (found) return found;
		this.join(uniqueName, { contributor: false });
		return this.who(uniqueName);
	}

	private link(from: number, rel: string, to: number): void {
		const item = this.get(from);
		this.get(to);
		this.items.set(from, { ...item, links: [...item.links, { rel, id: to }] });
	}

	private itemUrl(id: number): string {
		return `https://dev.azure.com/${encodeURIComponent(this.organization)}/_apis/wit/workItems/${String(id)}`;
	}

	private get(id: number): WorkItem {
		const item = this.items.get(id);
		if (item === undefined) throw fault(`no work item ${String(id)}`);
		return item;
	}

	private tick(): string {
		this.clock += 60_000;
		return new Date(this.clock).toISOString();
	}
}

const CONTRIBUTORS = 'Microsoft.TeamFoundation.Identity;S-1-9-1551374245-1-contributors';
const TEAM = 'Microsoft.TeamFoundation.Identity;S-1-9-1551374245-2-team';
const READERS = 'Microsoft.TeamFoundation.Identity;S-1-9-1551374245-3-readers';

function tagList(value: unknown): string[] {
	if (typeof value !== 'string') return [];
	return value
		.split(';')
		.map((t) => t.trim())
		.filter((t) => t !== '');
}
