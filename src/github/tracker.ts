// GitHub Issues as a Tracker: a Feature is an issue with sub-issues, its Tickets; blocking links
// are GitHub's issue dependencies; Signals are labels; a Ticket is referenced as #N.
import { z } from 'zod';
import { firstLine } from '../git.js';
import { SIGNALS, type Signal, type SignalNames } from '../signals.js';
import type {
	Comment,
	Feature,
	FeatureWriter,
	ItemId,
	ItemText,
	Ticket,
	TicketReference,
	Tracker
} from '../tracker.js';
import {
	GitHubApi,
	GitHubFailure,
	IssueSchema,
	PAGE,
	type GhRunner,
	type RawIssue
} from './api.js';

const CommentSchema = z.looseObject({
	body: z.string().nullable(),
	user: z.looseObject({ login: z.string() }).nullable(),
	created_at: z.string(),
	author_association: z.string().optional()
});

// The associations that stand in for write access when the permission call itself is refused.
// A COLLABORATOR on an organization's repo may hold only read: the permission call is the sure answer.
const TIED = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const WRITE = ['admin', 'maintain', 'write'];

// The issue number an id names; GitHub has no other kind of id.
function issue(id: ItemId): string {
	if (!/^\d+$/.test(id)) throw new GitHubFailure(`${id} is no GitHub issue number.`);
	return id;
}

const toFeature = (raw: RawIssue): Feature => ({
	id: String(raw.number),
	title: raw.title,
	body: raw.body ?? ''
});

export class GitHubTracker implements Tracker, FeatureWriter {
	private readonly api: GitHubApi;
	private readonly writers = new Map<string, boolean>();

	constructor(
		readonly repo: string,
		gh: GhRunner,
		private readonly names: SignalNames,
		// factory.json's trusted list; when set it replaces the write-access default
		private readonly trusted?: readonly string[]
	) {
		this.api = new GitHubApi(repo, gh);
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
		const query = new URLSearchParams({
			state: 'open',
			labels: this.names.go,
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
		return raw
			.filter((i) => i.pull_request === undefined && (i.sub_issues_summary?.total ?? 0) > 0)
			.map(toFeature);
	}

	async feature(id: ItemId): Promise<Feature> {
		const n = issue(id);
		return toFeature(
			await this.api.parse(`read issue #${n}`, [`repos/${this.repo}/issues/${n}`], IssueSchema)
		);
	}

	async tickets(featureId: ItemId): Promise<Ticket[]> {
		const n = issue(featureId);
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
				trusted: await this.isTrusted(author, c.author_association)
			});
		}
		return comments;
	}

	// Whether `login` is trusted: on the configured list, else may push to the repo. `association` is the comment's own author_association,
	// which answers when a proxy refuses the permission call.
	private async isTrusted(login: string, association?: string): Promise<boolean> {
		// GitHub logins are case-insensitive
		if (this.trusted !== undefined) {
			return this.trusted.some((t) => t.toLowerCase() === login.toLowerCase());
		}
		const known = this.writers.get(login);
		if (known !== undefined) return known;
		const got = await this.api.raw([
			`repos/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`
		]);
		// 404 is GitHub's answer for a login that is no collaborator; any other refusal read as no
		// access would drop the person's own answers without a word
		if (!got.ok && !/HTTP 404/.test(got.err)) {
			if (association !== undefined) return TIED.includes(association);
			throw new GitHubFailure(
				`gh could not read the permission of ${login}: ${firstLine(got.err)}`
			);
		}
		let value: unknown = null;
		try {
			value = got.ok ? JSON.parse(got.out) : null;
		} catch {
			// no JSON reads as no permission
		}
		const parsed = z.looseObject({ permission: z.string() }).safeParse(value);
		const can = parsed.success && WRITE.includes(parsed.data.permission);
		this.writers.set(login, can);
		return can;
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
