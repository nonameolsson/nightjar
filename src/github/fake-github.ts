// A small GitHub kept in memory behind a stand-in for `gh api`: issues, their sub-issues, blocking
// links, labels and comments, as GitHub's REST API answers them. The GitHub adapters run over it
// in the contract specs, so no spec reaches the network.
import type { Run } from '../git.js';
import type { GhRunner } from './api.js';
import { failed, ok, readCall, type GhCall } from './fake-gh.js';

export interface NewIssue {
	readonly title: string;
	readonly body: string | null;
	readonly state: 'open' | 'closed';
	readonly labels: readonly string[];
	readonly assignees: readonly string[];
}

interface PullHead {
	readonly head: string;
	readonly base: string;
	readonly draft: boolean;
}

// On GitHub a pull request is an issue too, numbered with the issues.
interface Issue extends NewIssue {
	readonly number: number;
	readonly subIssues: readonly number[];
	readonly blockedBy: readonly number[];
	readonly pull?: PullHead;
}

export interface ShownPull extends PullHead {
	readonly title: string;
	readonly body: string;
}

interface IssueComment {
	readonly login: string;
	readonly body: string;
	readonly createdAt: string;
}

const NOT_FOUND = failed('gh: Not Found (HTTP 404)');

export class FakeGitHub {
	private readonly issues = new Map<number, Issue>();
	private readonly comments = new Map<number, IssueComment[]>();
	private readonly permissions = new Map<string, string>();

	constructor(
		readonly repo: string,
		// the login gh is signed in as
		readonly person: string
	) {}

	// Opens an issue and gives back its number.
	issue(issue: NewIssue): number {
		const number = this.issues.size + 1;
		this.issues.set(number, { ...issue, number, subIssues: [], blockedBy: [] });
		return number;
	}

	addSubIssue(parent: number, child: number): void {
		this.change(parent, (i) => ({ subIssues: [...i.subIssues, child] }));
	}

	block(blocked: number, by: number): void {
		this.change(blocked, (i) => ({ blockedBy: [...i.blockedBy, by] }));
	}

	say(number: number, login: string, body: string): IssueComment {
		const at = new Date(Date.UTC(2026, 9, 30, 9, this.commentCount())).toISOString();
		const comment = { login, body, createdAt: at };
		this.comments.set(number, [...(this.comments.get(number) ?? []), comment]);
		return comment;
	}

	// Makes `login` a collaborator with `permission` (read, write, maintain, admin).
	grant(login: string, permission: string): void {
		this.permissions.set(login, permission);
	}

	// Pull request `number` as GitHub shows it.
	pullAt(number: number): ShownPull {
		const issue = this.issues.get(number);
		if (issue?.pull === undefined) {
			throw new Error(`the fake GitHub has no pull request #${String(number)}`);
		}
		return { ...issue.pull, title: issue.title, body: issue.body ?? '' };
	}

	// The bodies of the comments on issue or pull request `number`, oldest first.
	said(number: number): string[] {
		return (this.comments.get(number) ?? []).map((c) => c.body);
	}

	readonly gh: GhRunner = (args) => Promise.resolve(this.answer(readCall(args)));

	private answer(call: GhCall): Run {
		const { method, path } = call;
		const repo = `repos/${this.repo}`;
		if (method === 'GET' && path === 'user') return ok({ login: this.person });
		if (method === 'GET' && path === `${repo}/issues`) return ok(this.list(call.query));
		if (method === 'GET' && path === `${repo}/pulls`) return ok(this.pulls(call.query));
		if (method === 'POST' && path === `${repo}/pulls`) return this.openPull(call);
		const pullNumber = new RegExp(`^${repo}/pulls/(\\d+)$`).exec(path);
		const pull = pullNumber ? this.issues.get(Number(pullNumber[1])) : undefined;
		if (pull?.pull !== undefined && method === 'GET') return ok(this.renderPull(pull));
		if (pull?.pull !== undefined && method === 'PATCH') {
			const body = call.fields.body;
			if (typeof body === 'string') this.change(pull.number, () => ({ body }));
			return ok(this.renderPull(this.get(pull.number)));
		}
		const asked = new RegExp(`^${repo}/collaborators/([^/]+)/permission$`).exec(path);
		if (method === 'GET' && asked) {
			return ok({ permission: this.permissions.get(decodeURIComponent(asked[1] ?? '')) ?? 'none' });
		}
		const issue = this.issueAt(path, repo);
		if (issue === undefined) return NOT_FOUND;
		const rest = path.slice(`${repo}/issues/${String(issue.number)}`.length);
		if (method === 'GET' && rest === '') return ok(this.render(issue));
		if (method === 'GET' && rest === '/sub_issues') return ok(this.renderAll(issue.subIssues));
		if (method === 'GET' && rest === '/dependencies/blocked_by') {
			return ok(this.renderAll(issue.blockedBy));
		}
		if (method === 'GET' && rest === '/comments') {
			return ok((this.comments.get(issue.number) ?? []).map((c) => this.renderComment(c)));
		}
		if (method === 'POST' && rest === '/comments') {
			return ok(this.renderComment(this.say(issue.number, this.person, String(call.fields.body))));
		}
		if (method === 'POST' && rest === '/labels') return this.label(issue, call);
		const label = /^\/labels\/([^/]+)$/.exec(rest);
		if (method === 'DELETE' && label)
			return this.unlabel(issue, decodeURIComponent(label[1] ?? ''));
		return NOT_FOUND;
	}

	// GitHub refuses a second open pull request for one head branch.
	private openPull(call: GhCall): Run {
		const field = (name: string) => {
			const value = call.fields[name];
			return typeof value === 'string' ? value : '';
		};
		const head = field('head');
		const taken = [...this.issues.values()].some(
			(i) => i.state === 'open' && i.pull?.head === head
		);
		if (taken) return failed(`gh: A pull request already exists for ${head}. (HTTP 422)`);
		const number = this.issue({
			title: field('title'),
			body: field('body'),
			state: 'open',
			labels: [],
			assignees: []
		});
		const pull = { head, base: field('base'), draft: field('draft') === 'true' };
		this.change(number, () => ({ pull }));
		return ok(this.renderPull(this.get(number)));
	}

	// GitHub's filters: state open by default, and head as owner:branch.
	private pulls(query: URLSearchParams) {
		const state = query.get('state') ?? 'open';
		const head = query.get('head');
		const owner = this.repo.split('/')[0] ?? '';
		return [...this.issues.values()]
			.filter(
				(i) =>
					i.pull !== undefined &&
					(state === 'all' || i.state === state) &&
					(head === null || head === `${owner}:${i.pull.head}`)
			)
			.map((i) => this.renderPull(i));
	}

	private renderPull(issue: Issue) {
		return {
			number: issue.number,
			html_url: this.url(issue.number),
			title: issue.title,
			body: issue.body,
			state: issue.state,
			draft: issue.pull?.draft ?? false,
			head: { ref: issue.pull?.head ?? '' },
			base: { ref: issue.pull?.base ?? '' }
		};
	}

	private url(number: number): string {
		return `https://github.com/${this.repo}/pull/${String(number)}`;
	}

	private label(issue: Issue, call: GhCall): Run {
		const asked = call.fields['labels[]'];
		const added = (Array.isArray(asked) ? asked : []).filter((l) => !issue.labels.includes(l));
		const labels = [...issue.labels, ...added];
		this.change(issue.number, () => ({ labels }));
		return ok(labels.map((name) => ({ name })));
	}

	// GitHub answers 404 for a label the issue lacks.
	private unlabel(issue: Issue, name: string): Run {
		if (!issue.labels.includes(name)) {
			return {
				...failed('gh: Label does not exist (HTTP 404)'),
				out: '{"message":"Label does not exist"}'
			};
		}
		const labels = issue.labels.filter((l) => l !== name);
		this.change(issue.number, () => ({ labels }));
		return ok(labels.map((l) => ({ name: l })));
	}

	// The issue a path such as repos/o/r/issues/7/comments names.
	private issueAt(path: string, repo: string): Issue | undefined {
		if (!path.startsWith(`${repo}/`)) return undefined;
		const match = /^\/issues\/(\d+)(?:\/|$)/.exec(path.slice(repo.length));
		return match ? this.issues.get(Number(match[1])) : undefined;
	}

	// GitHub's filters: state open by default, every label named, the assignee, newest first by default.
	private list(query: URLSearchParams) {
		const state = query.get('state') ?? 'open';
		const labels = (query.get('labels') ?? '').split(',').filter((l) => l !== '');
		const assignee = query.get('assignee');
		const found = [...this.issues.values()].filter(
			(i) =>
				(state === 'all' || i.state === state) &&
				labels.every((l) => i.labels.includes(l)) &&
				(assignee === null || i.assignees.includes(assignee))
		);
		if (query.get('direction') !== 'asc') found.reverse();
		return found.map((i) => this.render(i));
	}

	private renderComment(comment: IssueComment) {
		const permission = this.permissions.get(comment.login) ?? 'none';
		return {
			body: comment.body,
			user: { login: comment.login },
			created_at: comment.createdAt,
			author_association: permission === 'none' ? 'NONE' : 'COLLABORATOR'
		};
	}

	private renderAll(numbers: readonly number[]) {
		return numbers.flatMap((n) => {
			const issue = this.issues.get(n);
			return issue ? [this.render(issue)] : [];
		});
	}

	private render(issue: Issue) {
		return {
			number: issue.number,
			title: issue.title,
			body: issue.body,
			state: issue.state,
			labels: issue.labels.map((name) => ({ name })),
			assignees: issue.assignees.map((login) => ({ login })),
			user: { login: this.person },
			sub_issues_summary: { total: issue.subIssues.length },
			...(issue.pull ? { pull_request: { html_url: this.url(issue.number) } } : {})
		};
	}

	private commentCount(): number {
		return [...this.comments.values()].reduce((n, list) => n + list.length, 0);
	}

	private get(number: number): Issue {
		const issue = this.issues.get(number);
		if (issue === undefined) throw new Error(`the fake GitHub has no issue #${String(number)}`);
		return issue;
	}

	private change(number: number, over: (issue: Issue) => Partial<Issue>): void {
		const issue = this.get(number);
		this.issues.set(number, { ...issue, ...over(issue) });
	}
}
