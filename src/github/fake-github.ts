// A small GitHub in memory behind a stand-in for `gh api`, answering as GitHub's REST API does.
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

// A check run on a commit, as an app reports it.
export interface NewCheckRun {
	readonly name: string;
	// queued, in_progress or completed
	readonly status: string;
	// set once completed: success, failure, timed_out, cancelled, skipped and others
	readonly conclusion?: string | null;
	// the app that reports it, github-actions by default
	readonly app?: string;
	readonly output?: { readonly title?: string; readonly summary?: string };
}

// A GitHub Actions job, reported as a check run whose id is the job's id.
export interface NewJob {
	readonly workflow: string;
	readonly name: string;
	readonly status?: string;
	readonly conclusion?: string | null;
	readonly steps: readonly { readonly name: string; readonly conclusion: string | null }[];
	// its whole log, each line stamped with its time as GitHub does; null once it has expired
	readonly log: string | null;
}

interface CheckRun extends NewCheckRun {
	readonly id: number;
}

// A commit status, the latest of its context.
export interface CommitStatus {
	readonly context: string;
	// error, failure, pending or success
	readonly state: string;
	readonly description?: string | null;
}

const NOT_FOUND = failed('gh: Not Found (HTTP 404)');

const INVALID = (why: string) => failed(`gh: Validation Failed: ${why} (HTTP 422)`);

// GitHub's own id of an issue, which its sub-issue and dependency calls take, apart from its number.
const databaseId = (number: number) => 4_000_000 + number * 7;

// An integer field, as `gh api -F` sends one; `-f` would send it as a string, which GitHub refuses.
function integerField(call: GhCall, name: string): number | null {
	for (let i = 0; i < call.args.length - 1; i += 1) {
		const field = call.args[i + 1] ?? '';
		if (call.args[i] === '-F' && field.startsWith(`${name}=`)) {
			const value = field.slice(name.length + 1);
			return /^\d+$/.test(value) ? Number(value) : null;
		}
	}
	return null;
}

export class FakeGitHub {
	private readonly issues = new Map<number, Issue>();
	private readonly comments = new Map<number, IssueComment[]>();
	private readonly permissions = new Map<string, string>();
	private readonly repoLabels = new Set<string>();
	// the commit each branch points at, as pushed
	private readonly heads = new Map<string, string>();
	// by commit
	private readonly checkRuns = new Map<string, CheckRun[]>();
	private readonly statuses = new Map<string, CommitStatus[]>();
	// by id, the id of its check run
	private readonly jobs = new Map<number, NewJob>();
	// by pull request number
	private readonly reviews = new Map<number, { login: string; state: string }[]>();
	private checkRunCount = 0;
	private signedOut = false;
	private labelsRefused = false;
	// every call gh was asked, in order
	readonly calls: GhCall[] = [];

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

	// `branch` now points at `commit`, as a push to it leaves it.
	pushed(branch: string, commit: string): void {
		this.heads.set(branch, commit);
	}

	// The commit pull request `number`'s head branch points at.
	headOf(number: number): string {
		return this.heads.get(this.pullAt(number).head) ?? '';
	}

	// An app reports a check run on `commit`; gives back its id.
	checkRun(commit: string, run: NewCheckRun): number {
		this.checkRunCount += 1;
		const id = 70_000 + this.checkRunCount;
		this.checkRuns.set(commit, [...(this.checkRuns.get(commit) ?? []), { ...run, id }]);
		return id;
	}

	// GitHub Actions runs a job on `commit`; gives back its id.
	actionsJob(commit: string, job: NewJob): number {
		const id = this.checkRun(commit, {
			name: job.name,
			status: job.status ?? 'completed',
			conclusion: job.conclusion ?? null,
			app: 'github-actions'
		});
		this.jobs.set(id, job);
		return id;
	}

	// A commit status on `commit`, in place of the one of its context.
	commitStatus(commit: string, status: CommitStatus): void {
		const others = (this.statuses.get(commit) ?? []).filter((s) => s.context !== status.context);
		this.statuses.set(commit, [...others, status]);
	}

	// No check run and no commit status on `commit`.
	clearChecks(commit: string): void {
		this.checkRuns.delete(commit);
		this.statuses.delete(commit);
	}

	// `login` reviews pull request `number`.
	review(number: number, login: string, state = 'COMMENTED'): void {
		this.reviews.set(number, [...(this.reviews.get(number) ?? []), { login, state }]);
	}

	// A person marks pull request `number` ready for review.
	markReady(number: number): void {
		const pull = this.pullAt(number);
		this.change(number, () => ({
			pull: { head: pull.head, base: pull.base, draft: false }
		}));
	}

	// A person closes issue or pull request `number`.
	close(number: number): void {
		this.change(number, () => ({ state: 'closed' }));
	}

	// A label the repo has, as one a team made itself.
	addRepoLabel(name: string): void {
		this.repoLabels.add(name);
	}

	// The names of the labels the repo has.
	repoLabelNames(): string[] {
		return [...this.repoLabels];
	}

	// From now on every call fails as gh does when it is not signed in.
	signOut(): void {
		this.signedOut = true;
	}

	// From now on the repo refuses new labels, as a token without the right to write them does.
	refuseLabels(): void {
		this.labelsRefused = true;
	}

	readonly gh: GhRunner = (args) => {
		const call = readCall(args);
		this.calls.push(call);
		return Promise.resolve(this.answer(call));
	};

	private answer(call: GhCall): Run {
		const { method, path } = call;
		const repo = `repos/${this.repo}`;
		if (this.signedOut) {
			return failed('To get started with GitHub CLI, please run:  gh auth login');
		}
		if (method === 'GET' && path === 'user') return ok({ login: this.person });
		if (method === 'POST' && path === `${repo}/labels`) return this.createLabel(call);
		const named = new RegExp(`^${repo}/labels/([^/]+)$`).exec(path);
		if (method === 'GET' && named) {
			return this.repoLabels.has(decodeURIComponent(named[1] ?? '')) ? ok({}) : NOT_FOUND;
		}
		if (method === 'GET' && path === `${repo}/issues`) return ok(this.list(call.query));
		if (method === 'POST' && path === `${repo}/issues`) return this.openIssue(call);
		if (method === 'GET' && path === `${repo}/pulls`) return ok(this.pulls(call.query));
		if (method === 'POST' && path === `${repo}/pulls`) return this.openPull(call);
		const reviewed = new RegExp(`^${repo}/pulls/(\\d+)/reviews$`).exec(path);
		if (method === 'GET' && reviewed) return this.renderReviews(Number(reviewed[1]));
		const checked = new RegExp(`^${repo}/commits/([^/]+)/(check-runs|status)$`).exec(path);
		if (method === 'GET' && checked) return this.renderChecks(checked[1] ?? '', checked[2] ?? '');
		const job = new RegExp(`^${repo}/actions/jobs/(\\d+)(/logs)?$`).exec(path);
		if (method === 'GET' && job) return this.renderJob(Number(job[1]), job[2] !== undefined);
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
		if (method === 'POST' && rest === '/sub_issues') return this.adopt(issue, call);
		if (method === 'POST' && rest === '/dependencies/blocked_by') return this.blockBy(issue, call);
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

	// GitHub answers 422 for a name the repo has, in the body as well as on stderr.
	private createLabel(call: GhCall): Run {
		const name = call.fields.name;
		if (typeof name !== 'string' || name === '') return INVALID('name is missing');
		if (this.repoLabels.has(name)) {
			return {
				...failed('gh: Validation Failed (HTTP 422)'),
				out: '{"message":"Validation Failed","errors":[{"code":"already_exists"}]}'
			};
		}
		if (this.labelsRefused) {
			return failed('gh: Resource not accessible by integration (HTTP 403)');
		}
		this.repoLabels.add(name);
		return ok({ name });
	}

	private openIssue(call: GhCall): Run {
		const title = call.fields.title;
		const body = call.fields.body;
		if (typeof title !== 'string' || title.trim() === '') return INVALID('title is missing');
		const number = this.issue({
			title,
			body: typeof body === 'string' ? body : null,
			state: 'open',
			labels: [],
			assignees: []
		});
		return ok(this.render(this.get(number)));
	}

	// The issue whose id `field` names, as GitHub takes it.
	private byId(call: GhCall, field: string): Issue | undefined {
		const id = integerField(call, field);
		return [...this.issues.values()].find((i) => databaseId(i.number) === id);
	}

	// GitHub gives a sub-issue one parent and puts it last among the parent's.
	private adopt(parent: Issue, call: GhCall): Run {
		const child = this.byId(call, 'sub_issue_id');
		if (child === undefined) return INVALID('sub_issue_id is not the id of an issue');
		const taken = [...this.issues.values()].some((i) => i.subIssues.includes(child.number));
		if (taken) return INVALID('the issue already has a parent');
		this.addSubIssue(parent.number, child.number);
		return ok(this.render(this.get(parent.number)));
	}

	private blockBy(blocked: Issue, call: GhCall): Run {
		const blocker = this.byId(call, 'issue_id');
		if (blocker === undefined) return INVALID('issue_id is not the id of an issue');
		if (!blocked.blockedBy.includes(blocker.number)) this.block(blocked.number, blocker.number);
		return ok(this.render(blocker));
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

	// GitHub's filters: state open by default, head as owner:branch, newest first unless asked otherwise.
	private pulls(query: URLSearchParams) {
		const state = query.get('state') ?? 'open';
		const head = query.get('head');
		const owner = this.repo.split('/')[0] ?? '';
		const found = [...this.issues.values()].filter(
			(i) =>
				i.pull !== undefined &&
				(state === 'all' || i.state === state) &&
				(head === null || head === `${owner}:${i.pull.head}`)
		);
		if (query.get('direction') !== 'asc') found.reverse();
		return found.map((i) => this.renderPull(i));
	}

	private renderPull(issue: Issue) {
		const head = issue.pull?.head ?? '';
		return {
			number: issue.number,
			html_url: this.url(issue.number),
			title: issue.title,
			body: issue.body,
			state: issue.state,
			draft: issue.pull?.draft ?? false,
			head: { ref: head, sha: this.heads.get(head) ?? '', repo: { full_name: this.repo } },
			base: { ref: issue.pull?.base ?? '' }
		};
	}

	private renderReviews(number: number): Run {
		if (this.issues.get(number)?.pull === undefined) return NOT_FOUND;
		return ok(
			(this.reviews.get(number) ?? []).map((r) => ({ user: { login: r.login }, state: r.state }))
		);
	}

	// The check runs on a commit, or its combined status: the latest status of each context.
	private renderChecks(commit: string, what: string): Run {
		if (what === 'status') {
			const statuses = this.statuses.get(commit) ?? [];
			return ok({ sha: commit, total_count: statuses.length, statuses });
		}
		const runs = (this.checkRuns.get(commit) ?? []).map((r) => ({
			id: r.id,
			name: r.name,
			head_sha: commit,
			status: r.status,
			conclusion: r.status === 'completed' ? (r.conclusion ?? null) : null,
			app: { slug: r.app ?? 'github-actions' },
			output: { title: r.output?.title ?? null, summary: r.output?.summary ?? null }
		}));
		return ok({ total_count: runs.length, check_runs: runs });
	}

	// A job, or its log as plain text; GitHub answers 410 for a log that has expired.
	private renderJob(id: number, log: boolean): Run {
		const job = this.jobs.get(id);
		if (job === undefined) return NOT_FOUND;
		if (log) {
			return job.log === null
				? failed('gh: Gone (HTTP 410)')
				: { ok: true, out: job.log, err: '', missing: false };
		}
		return ok({
			id,
			name: job.name,
			workflow_name: job.workflow,
			status: job.status ?? 'completed',
			conclusion: job.conclusion ?? null,
			steps: job.steps.map((s, i) => ({ ...s, number: i + 1 }))
		});
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
			id: databaseId(issue.number),
			number: issue.number,
			title: issue.title,
			body: issue.body,
			state: issue.state,
			labels: issue.labels.map((name) => ({ name })),
			assignees: issue.assignees.map((login) => ({ login })),
			user: { login: this.person },
			sub_issues_summary: {
				total: issue.subIssues.length,
				completed: issue.subIssues.filter((n) => this.issues.get(n)?.state === 'closed').length
			},
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
