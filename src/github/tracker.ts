// GitHub Issues as a Tracker: a Feature is an issue with sub-issues; blocking links are issue dependencies.
import { z } from 'zod';
import { firstLine } from '../git.js';
import { SIGNALS, type Signal, type SignalNames } from '../signals.js';
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
import { markerSearch } from '../template.js';
import {
	GitHubApi,
	GitHubFailure,
	IssueSchema,
	PAGE,
	type GhRunner,
	type RawIssue
} from './api.js';
import { GitHubTrust } from './trust.js';

const CommentSchema = z.looseObject({
	body: z.string().nullable(),
	user: z.looseObject({ login: z.string() }).nullable(),
	created_at: z.string(),
	author_association: z.string().optional()
});

const SearchSchema = z.looseObject({
	items: z.array(IssueSchema.extend({ created_at: z.string() }))
});

// GitHub's search pages hold 100 at most and reach no further than 1,000 results.
const SEARCH_PAGES = 10;

// The issue number an id names; GitHub has no other kind of id.
function issue(id: ItemId): string {
	if (!/^\d+$/.test(id)) throw new GitHubFailure(`${id} is no GitHub issue number.`);
	return id;
}

// A lone issue has no sub-issues, open or closed, and no parent; with no summary GitHub cannot tell, so it is none.
const isLone = (raw: RawIssue): boolean =>
	raw.sub_issues_summary?.total === 0 && !raw.parent_issue_url;

const toFeature = (raw: RawIssue): Feature => ({
	id: String(raw.number),
	title: raw.title,
	body: raw.body ?? '',
	...(isLone(raw) ? { lone: true as const } : {})
});

// the number an issue URL ends in
const parentOf = (url: string): ItemId => url.slice(url.lastIndexOf('/') + 1);

// null where GitHub gave no summary, or one without the closed count; a lone issue is one Ticket
function countOf(raw: RawIssue): TicketCount | null {
	const summary = raw.sub_issues_summary;
	if (summary?.completed === undefined) return null;
	if (isLone(raw)) return { total: 1, closed: 0 };
	return { total: summary.total, closed: summary.completed };
}

export class GitHubTracker implements Tracker, FeatureWriter {
	private readonly api: GitHubApi;
	readonly loneIssues = true;
	private readonly counts = new Map<ItemId, TicketCount>();
	private readonly trust: GitHubTrust;

	constructor(
		readonly repo: string,
		gh: GhRunner,
		private readonly names: SignalNames,
		// factory.json's trusted list; when set it replaces the write-access default
		trusted?: readonly string[]
	) {
		this.api = new GitHubApi(repo, gh);
		this.trust = new GitHubTrust(this.api, trusted);
	}

	private signalsOf(raw: RawIssue): Signal[] {
		const labels = raw.labels.map((l) => l.name);
		return SIGNALS.filter((s) => labels.includes(this.names[s]));
	}

	async me(): Promise<string> {
		const user = await this.api.parse(
			'read the signed-in user',
			['user'],
			z.looseObject({ login: z.string() })
		);
		return user.login;
	}

	async assignedFeatures(person: string): Promise<Feature[]> {
		return this.featuresWith(person, this.names.go);
	}

	// labels in one query must all be there, so each Signal is asked for alone
	waitingOn(person: string): Promise<WaitingFeature[]> {
		return waitingFrom((signal) => this.featuresWith(person, this.names[signal]));
	}

	// the issues whose body holds the Source's marker, open or closed, oldest first
	async featuresFrom(source: string): Promise<SourcedFeature[]> {
		const q = `repo:${this.repo} is:issue in:body "${markerSearch(source)}"`;
		// a search reaches 1,000 results: newest first keeps today's, and the open ones are asked for alone so an old one is not lost
		const found = new Map<number, z.infer<typeof SearchSchema>['items'][number]>();
		for (const query of [q, `${q} is:open`]) {
			for (const item of await this.searchNewestFirst(source, query)) found.set(item.number, item);
		}
		return sourcedFrom(
			source,
			[...found.values()]
				.filter((i) => i.pull_request === undefined)
				.map((i) => ({
					id: String(i.number),
					body: i.body ?? '',
					open: i.state === 'open',
					at: i.created_at
				}))
		);
	}

	private async searchNewestFirst(
		source: string,
		q: string
	): Promise<z.infer<typeof SearchSchema>['items']> {
		const found: z.infer<typeof SearchSchema>['items'] = [];
		for (let page = 1; page <= SEARCH_PAGES; page += 1) {
			const query = new URLSearchParams({
				q,
				sort: 'created',
				order: 'desc',
				per_page: '100',
				page: String(page)
			});
			const got = await this.api.parse(
				`search the issues of Source ${source}`,
				[`search/issues?${query.toString()}`],
				SearchSchema
			);
			found.push(...got.items);
			if (got.items.length < 100) break;
		}
		return found;
	}

	// the open Features assigned to `person` that carry the label, oldest first
	private async featuresWith(person: string, label: string): Promise<Feature[]> {
		const query = new URLSearchParams({
			state: 'open',
			labels: label,
			assignee: person,
			sort: 'created',
			direction: 'asc',
			per_page: '100'
		});
		const raw = await this.api.parse(
			'list the assigned issues',
			[`repos/${this.repo}/issues?${query.toString()}`],
			z.array(IssueSchema)
		);
		for (const i of raw) this.remember(i);
		return raw
			.filter(
				(i) => i.pull_request === undefined && ((i.sub_issues_summary?.total ?? 0) > 0 || isLone(i))
			)
			.map(toFeature);
	}

	// the sub-issue summary of every issue the lists gave, so counting a listed Feature costs no call
	private remember(raw: RawIssue): void {
		const count = countOf(raw);
		const id = String(raw.number);
		if (count === null) this.counts.delete(id);
		else this.counts.set(id, count);
	}

	// A Feature the lists have not given is read on its own; one that cannot be read has no count.
	async ticketCounts(ids: readonly ItemId[]): Promise<Map<ItemId, TicketCount | null>> {
		const found = new Map<ItemId, TicketCount | null>();
		for (const id of ids) {
			let count = this.counts.get(id) ?? null;
			if (count === null) {
				try {
					const n = issue(id);
					const raw = await this.api.parse(
						`read issue #${n}`,
						[`repos/${this.repo}/issues/${n}`],
						IssueSchema
					);
					count = countOf(raw);
				} catch {
					count = null;
				}
			}
			found.set(id, count);
		}
		return found;
	}

	async feature(id: ItemId): Promise<Feature> {
		const n = issue(id);
		return toFeature(
			await this.api.parse(`read issue #${n}`, [`repos/${this.repo}/issues/${n}`], IssueSchema)
		);
	}

	async standing(id: ItemId): Promise<Standing> {
		const n = issue(id);
		const raw = await this.api.parse(
			`read issue #${n}`,
			[`repos/${this.repo}/issues/${n}`],
			IssueSchema
		);
		const parent =
			raw.sub_issues_summary?.total === 0 && raw.parent_issue_url
				? parentOf(raw.parent_issue_url)
				: undefined;
		return {
			assignees: (raw.assignees ?? []).map((a) => a.login),
			signals: this.signalsOf(raw),
			...(parent === undefined ? {} : { parent })
		};
	}

	async tickets(featureId: ItemId): Promise<Ticket[]> {
		const n = issue(featureId);
		const self = await this.api.parse(
			`read issue #${n}`,
			[`repos/${this.repo}/issues/${n}`],
			IssueSchema
		);
		// a lone issue is its own Ticket, ready by being given the Go
		if (isLone(self)) {
			const signals = this.signalsOf(self);
			return [
				{
					id: n,
					title: self.title,
					body: self.body ?? '',
					open: self.state === 'open',
					signals: signals.includes('ready') ? signals : [...signals, 'ready'],
					blockedBy: await this.blockedBy(n)
				}
			];
		}
		const children = await this.api.parse(
			`list the sub-issues of #${n}`,
			[`repos/${this.repo}/issues/${n}/sub_issues?${PAGE}`],
			z.array(IssueSchema)
		);
		const tickets: Ticket[] = [];
		for (const child of children) {
			tickets.push({
				id: String(child.number),
				title: child.title,
				body: child.body ?? '',
				open: child.state === 'open',
				signals: this.signalsOf(child),
				blockedBy: await this.blockedBy(String(child.number))
			});
		}
		return tickets;
	}

	private async blockedBy(id: ItemId) {
		const n = issue(id);
		const raw = await this.api.parse(
			`list what blocks #${n}`,
			[`repos/${this.repo}/issues/${n}/dependencies/blocked_by?${PAGE}`],
			z.array(IssueSchema)
		);
		return raw.map((i) => ({ id: String(i.number), open: i.state === 'open' }));
	}

	async comments(id: ItemId): Promise<Comment[]> {
		const n = issue(id);
		const raw = await this.api.parse(
			`list the comments on #${n}`,
			[`repos/${this.repo}/issues/${n}/comments?${PAGE}`],
			z.array(CommentSchema)
		);
		const comments: Comment[] = [];
		for (const c of raw) {
			const author = c.user?.login ?? '';
			comments.push({
				author,
				body: c.body ?? '',
				at: c.created_at,
				trusted: await this.trust.isTrusted(author, c.author_association)
			});
		}
		return comments;
	}

	trusts(person: string): Promise<boolean> {
		return this.trust.isTrusted(person);
	}

	// GitHub drops an assignee it cannot assign without a word, so the answer is read for them.
	async assign(id: ItemId, person: string): Promise<void> {
		const n = issue(id);
		const got = await this.api.parse(
			`assign #${n} to ${person}`,
			['-X', 'POST', `repos/${this.repo}/issues/${n}/assignees`, '-f', `assignees[]=${person}`],
			IssueSchema
		);
		const held = (got.assignees ?? []).some((a) => a.login.toLowerCase() === person.toLowerCase());
		if (!held) {
			throw new GitHubFailure(
				`GitHub did not assign #${n} to ${person}, who cannot be assigned issues on ${this.repo}.`
			);
		}
	}

	async addSignal(id: ItemId, signal: Signal): Promise<void> {
		const n = issue(id);
		const label = this.names[signal];
		await this.api.call(`label #${n} ${label}`, [
			'-X',
			'POST',
			`repos/${this.repo}/issues/${n}/labels`,
			'-f',
			`labels[]=${label}`
		]);
	}

	async removeSignal(id: ItemId, signal: Signal): Promise<void> {
		const n = issue(id);
		const label = this.names[signal];
		const got = await this.api.raw([
			'-X',
			'DELETE',
			`repos/${this.repo}/issues/${n}/labels/${encodeURIComponent(label)}`
		]);
		if (!got.ok && !/404|Label does not exist/.test(got.err + got.out)) {
			throw new GitHubFailure(`gh could not take ${label} off #${n}: ${firstLine(got.err)}`);
		}
	}

	async comment(id: ItemId, body: string): Promise<void> {
		const n = issue(id);
		await this.api.call(`comment on #${n}`, [
			'-X',
			'POST',
			`repos/${this.repo}/issues/${n}/comments`,
			'-f',
			`body=${body}`
		]);
	}

	reference(id: ItemId): TicketReference {
		return { id, text: `#${issue(id)}` };
	}

	async createFeature({ title, body }: ItemText): Promise<ItemId> {
		const made = await this.api.parse(
			`open the issue ${title}`,
			['-X', 'POST', `repos/${this.repo}/issues`, '-f', `title=${title}`, '-f', `body=${body}`],
			IssueSchema
		);
		return String(made.number);
	}

	async createTicket(featureId: ItemId, ticket: ItemText): Promise<ItemId> {
		const id = await this.createFeature(ticket);
		const n = issue(featureId);
		await this.api.call(`make #${id} a sub-issue of #${n}`, [
			'-X',
			'POST',
			`repos/${this.repo}/issues/${n}/sub_issues`,
			'-F',
			`sub_issue_id=${String(await this.databaseId(id))}`
		]);
		return id;
	}

	async block(id: ItemId, blocker: ItemId): Promise<void> {
		const n = issue(id);
		await this.api.call(`mark #${n} blocked by #${issue(blocker)}`, [
			'-X',
			'POST',
			`repos/${this.repo}/issues/${n}/dependencies/blocked_by`,
			'-F',
			`issue_id=${String(await this.databaseId(blocker))}`
		]);
	}

	// GitHub's own id of issue `id`, which the sub-issue and dependency calls take.
	private async databaseId(id: ItemId): Promise<number> {
		const n = issue(id);
		const raw = await this.api.parse(
			`read issue #${n}`,
			[`repos/${this.repo}/issues/${n}`],
			IssueSchema
		);
		if (raw.id === undefined) throw new GitHubFailure(`GitHub gave no id for #${n}.`);
		return raw.id;
	}
}
