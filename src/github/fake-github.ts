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
	readonly id: number;
	readonly login: string;
	readonly body: string;
	readonly createdAt: string;
}

// A check run on a commit, as an app reports it.
export interface NewCheckRun {
	readonly name: string;
	// queued, in_progress or completed; completed by default
	readonly status?: string;
	// set once completed: success, failure, timed_out, cancelled, skipped and others
	readonly conclusion?: string | null;
	// the slug of the app that reports it, github-actions by default; null for a check no app made
	readonly app?: string | null;
	readonly output?: {
		readonly title?: string;
		readonly summary?: string;
		readonly text?: string;
	};
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
	readonly commit: string;
	readonly completedAt: string;
}

// A commit status, the latest of its context.
export interface CommitStatus {
	readonly context: string;
	// error, failure, pending or success
	readonly state: string;
	readonly description?: string | null;
}

// A comment on a line of a pull request's diff; a reply names the comment it answers.
interface LineComment {
	readonly id: number;
	readonly pull: number;
	readonly login: string;
	readonly body: string;
	readonly createdAt: string;
	readonly path: string;
	// null once the head commit no longer has the line
	readonly line: number | null;
	readonly inReplyTo?: number;
}

interface Review {
	readonly id: number;
	readonly pull: number;
	readonly login: string;
	readonly body: string | null;
	readonly state: string;
	readonly submittedAt: string;
}

// A commit a push brought, dated when GitHub first saw it.
interface PushedCommit {
	readonly sha: string;
	readonly message: string;
	readonly date: string;
}

const NOT_FOUND = failed('gh: Not Found (HTTP 404)');

const INVALID = (why: string) => failed(`gh: Validation Failed: ${why} (HTTP 422)`);

// GitHub's own id of an issue, which its sub-issue and dependency calls take, apart from its number.
const databaseId = (number: number) => 4_000_000 + number * 7;

// GitHub's own paging: thirty to a page unless per_page says otherwise.
function page<T>(list: readonly T[], query: URLSearchParams): T[] {
	const size = Number(query.get('per_page') ?? 30);
	const at = Number(query.get('page') ?? 1);
	return list.slice((at - 1) * size, at * size);
}

// The commit a pull request's head branch points at, as far as the fake has one.
const headSha = (number: number) => `${String(number).padStart(8, '0')}${'ab'.repeat(16)}`;

function renderCheck(run: CheckRun) {
	const status = run.status ?? 'completed';
	return {
		id: run.id,
		name: run.name,
		head_sha: run.commit,
		status,
		conclusion: status === 'completed' ? (run.conclusion ?? null) : null,
		completed_at: status === 'completed' ? run.completedAt : null,
		app: run.app === null ? null : { slug: run.app ?? 'github-actions' },
		output: { title: null, summary: null, text: null, ...run.output }
	};
}

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
	private readonly lineComments: LineComment[] = [];
	private readonly reviews: Review[] = [];
	private readonly checkRuns: CheckRun[] = [];
	// one count for every kind of comment, so no two ids are alike
	private lastId = 0;
	private lastMinute = 0;
	private readonly repoLabels = new Set<string>();
	// the commit each branch points at, as pushed
	private readonly heads = new Map<string, string>();
	// the commits each branch holds that its base lacks, oldest first, as pushed
	private readonly branchCommits = new Map<string, PushedCommit[]>();
	// by commit
	private readonly statuses = new Map<string, CommitStatus[]>();
	// by id, the id of its check run
	private readonly jobs = new Map<number, NewJob>();
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
		const comment = { id: this.nextId(), login, body, createdAt: at };
		this.comments.set(number, [...(this.comments.get(number) ?? []), comment]);
		return comment;
	}

	// A comment on a line of the diff of pull request `pull`; `line` null is a line the head commit lost. Gives its id.
	lineComment(
		pull: number,
		comment: { login: string; body: string; path: string; line: number | null }
	): number {
		this.pullAt(pull);
		const id = this.nextId();
		this.lineComments.push({ ...comment, id, pull, createdAt: this.stamp() });
		return id;
	}

	// A reply in the thread of line comment `answered`. Gives its id.
	replyTo(answered: number, login: string, body: string): number {
		const first = this.lineCommentAt(answered);
		if (first === undefined) {
			throw new Error(`the fake GitHub has no line comment ${String(answered)}`);
		}
		const id = this.nextId();
		this.lineComments.push({
			id,
			pull: first.pull,
			login,
			body,
			createdAt: this.stamp(),
			path: first.path,
			line: first.line,
			inReplyTo: first.inReplyTo ?? first.id
		});
		return id;
	}

	// A review of pull request `pull`; its body may be empty, as an approval's is. Gives its id.
	review(pull: number, review: { login: string; body: string | null; state?: string }): number {
		this.pullAt(pull);
		const id = this.nextId();
		this.reviews.push({
			id,
			pull,
			login: review.login,
			body: review.body,
			state: review.state ?? 'COMMENTED',
			submittedAt: this.stamp()
		});
		return id;
	}

	// An app reports a check run on `commit`, or on the head commit of pull request number `commit`. Gives its id.
	checkRun(commit: string | number, run: NewCheckRun): number {
		const on = typeof commit === 'number' ? this.shaOf(commit) : commit;
		const id = this.nextId();
		this.checkRuns.push({ ...run, id, commit: on, completedAt: this.stamp() });
		return id;
	}

	// The bodies of the replies in the thread of line comment `answered`, oldest first.
	thread(answered: number): string[] {
		return this.lineComments.filter((c) => c.inReplyTo === answered).map((c) => c.body);
	}

	private nextId(): number {
		this.lastId += 1;
		return this.lastId;
	}

	// a time later than every comment `say` dates, one minute on from the last
	private stamp(): string {
		this.lastMinute += 1;
		return new Date(Date.UTC(2026, 9, 31, 0, this.lastMinute)).toISOString();
	}

	private lineCommentAt(id: number): LineComment | undefined {
		return this.lineComments.find((c) => c.id === id);
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

	// `branch` now points at `commit`, as a push to it leaves it; `commits` are those the branch holds that its base lacks, oldest first, and one GitHub has not seen yet is dated now.
	pushed(
		branch: string,
		commit: string,
		commits: readonly { readonly sha: string; readonly message: string }[] = []
	): void {
		this.heads.set(branch, commit);
		const known = new Map((this.branchCommits.get(branch) ?? []).map((c) => [c.sha, c]));
		this.branchCommits.set(
			branch,
			commits.map((c) => known.get(c.sha) ?? { ...c, date: this.stamp() })
		);
	}

	// The commit pull request `number`'s head branch points at.
	headOf(number: number): string {
		return this.heads.get(this.pullAt(number).head) ?? '';
	}

	// The commit pull request `number` is at: the one its head branch was pushed to, else a stand-in.
	private shaOf(number: number): string {
		return this.heads.get(this.pullAt(number).head) ?? headSha(number);
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
		const kept = this.checkRuns.filter((r) => r.commit !== commit);
		this.checkRuns.splice(0, this.checkRuns.length, ...kept);
		this.statuses.delete(commit);
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
		if (method === 'GET' && path === 'search/issues') return this.search(call.query);
		if (method === 'POST' && path === `${repo}/issues`) return this.openIssue(call);
		if (method === 'GET' && path === `${repo}/pulls`) return ok(this.pulls(call.query));
		if (method === 'POST' && path === `${repo}/pulls`) return this.openPull(call);
		const checked = new RegExp(`^${repo}/commits/([^/]+)/(check-runs|status)$`).exec(path);
		if (method === 'GET' && checked) {
			return this.renderChecks(checked[1] ?? '', checked[2] ?? '', call.query);
		}
		const job = new RegExp(`^${repo}/actions/jobs/(\\d+)(/logs)?$`).exec(path);
		if (method === 'GET' && job) return this.renderJob(Number(job[1]), job[2] !== undefined);
		const commitsOf = new RegExp(`^${repo}/pulls/(\\d+)/commits$`).exec(path);
		if (method === 'GET' && commitsOf) return this.renderCommits(Number(commitsOf[1]), call.query);
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
		const feedback = this.feedbackRoute(call);
		if (feedback !== undefined) return feedback;
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
			const listed = page(this.comments.get(issue.number) ?? [], call.query);
			return ok(listed.map((c) => this.renderComment(c, issue.number)));
		}
		if (method === 'POST' && rest === '/comments') {
			return ok(
				this.renderComment(
					this.say(issue.number, this.person, String(call.fields.body)),
					issue.number
				)
			);
		}
		if (method === 'POST' && rest === '/labels') return this.label(issue, call);
		if (method === 'POST' && rest === '/assignees') return this.assign(issue, call);
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
		return page(found, query).map((i) => this.renderPull(i));
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
			head: {
				ref: head,
				sha: this.shaOf(issue.number),
				repo: { full_name: this.repo }
			},
			base: { ref: issue.pull?.base ?? '' }
		};
	}

	// The commits of a pull request's head branch, oldest first, each dated by its committer.
	private renderCommits(number: number, query: URLSearchParams): Run {
		const head = this.issues.get(number)?.pull?.head;
		if (head === undefined) return NOT_FOUND;
		const commits = page(this.branchCommits.get(head) ?? [], query);
		return ok(
			commits.map((c) => {
				const who = { name: 'Test', email: 'test@example.com', date: c.date };
				return { sha: c.sha, commit: { message: c.message, author: who, committer: who } };
			})
		);
	}

	// The check runs on a commit, or its combined status: the latest status of each context.
	private renderChecks(commit: string, what: string, query: URLSearchParams): Run {
		if (what === 'status') {
			const statuses = this.statuses.get(commit) ?? [];
			return ok({ sha: commit, total_count: statuses.length, statuses });
		}
		const runs = this.checkRuns.filter((r) => r.commit === commit);
		return ok({ total_count: runs.length, check_runs: page(runs, query).map(renderCheck) });
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

	// GitHub assigns only the signed-in person and the repo's collaborators, and drops anyone else without a word.
	private assign(issue: Issue, call: GhCall): Run {
		const asked = call.fields['assignees[]'];
		const added = (Array.isArray(asked) ? asked : []).filter(
			(login) =>
				!issue.assignees.includes(login) &&
				(login === this.person || (this.permissions.get(login) ?? 'none') !== 'none')
		);
		this.change(issue.number, (i) => ({ assignees: [...i.assignees, ...added] }));
		return ok(this.render(this.get(issue.number)));
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

	// GitHub's issue search as far as Nightjar asks: this repo, issues, the body, optionally only the open ones, and quoted phrases that must all be in it.
	private search(query: URLSearchParams): Run {
		const phrases: string[] = [];
		let openOnly = false;
		for (const term of (query.get('q') ?? '').match(/"[^"]*"|\S+/g) ?? []) {
			if (term.startsWith('"')) phrases.push(term.slice(1, -1).toLowerCase());
			else if (term === 'is:open') openOnly = true;
			else if (![`repo:${this.repo}`, 'is:issue', 'in:body'].includes(term)) {
				return INVALID(`the fake GitHub search does not know ${term}`);
			}
		}
		const found = [...this.issues.values()].filter((i) => {
			const body = (i.body ?? '').toLowerCase();
			return (
				i.pull === undefined &&
				(!openOnly || i.state === 'open') &&
				phrases.every((p) => body.includes(p))
			);
		});
		if (query.get('order') !== 'asc') found.reverse();
		const size = Number(query.get('per_page') ?? '30');
		const from = (Number(query.get('page') ?? '1') - 1) * size;
		return ok({
			total_count: found.length,
			incomplete_results: false,
			items: found.slice(from, from + size).map((i) => this.render(i))
		});
	}

	// each issue is made a minute after the one before
	private createdAt(number: number): string {
		return new Date(Date.UTC(2026, 9, 30, 8, number)).toISOString();
	}

	private renderComment(comment: IssueComment, number: number) {
		return {
			id: comment.id,
			issue_url: `https://api.github.com/repos/${this.repo}/issues/${String(number)}`,
			body: comment.body,
			user: { login: comment.login },
			created_at: comment.createdAt,
			author_association: this.association(comment.login)
		};
	}

	private association(login: string): string {
		return (this.permissions.get(login) ?? 'none') === 'none' ? 'NONE' : 'COLLABORATOR';
	}

	// The routes of a pull request's feedback; undefined for any other call.
	private feedbackRoute({ method, path, query, fields }: GhCall): Run | undefined {
		const repo = `repos/${this.repo}`;
		if (method === 'GET') {
			const inPull = new RegExp(`^${repo}/pulls/(\\d+)/(comments|reviews)$`).exec(path);
			const number = Number(inPull?.[1]);
			if (inPull?.[2] === 'comments') {
				const there = this.lineComments.filter((c) => c.pull === number);
				return ok(page(there, query).map((c) => this.renderLineComment(c)));
			}
			if (inPull?.[2] === 'reviews') {
				const there = this.reviews.filter((r) => r.pull === number);
				return ok(page(there, query).map((r) => this.renderReview(r)));
			}
			const line = new RegExp(`^${repo}/pulls/comments/(\\d+)$`).exec(path);
			if (line !== null) {
				const found = this.lineCommentAt(Number(line[1]));
				return found === undefined ? NOT_FOUND : ok(this.renderLineComment(found));
			}
			const review = new RegExp(`^${repo}/pulls/(\\d+)/reviews/(\\d+)$`).exec(path);
			if (review !== null) {
				const found = this.reviews.find(
					(r) => r.pull === Number(review[1]) && r.id === Number(review[2])
				);
				return found === undefined ? NOT_FOUND : ok(this.renderReview(found));
			}
			const check = new RegExp(`^${repo}/check-runs/(\\d+)$`).exec(path);
			if (check !== null) {
				const found = this.checkRuns.find((r) => r.id === Number(check[1]));
				return found === undefined ? NOT_FOUND : ok(renderCheck(found));
			}
			const said = new RegExp(`^${repo}/issues/comments/(\\d+)$`).exec(path);
			if (said !== null) {
				for (const [number, listed] of this.comments) {
					const found = listed.find((c) => c.id === Number(said[1]));
					if (found !== undefined) return ok(this.renderComment(found, number));
				}
				return NOT_FOUND;
			}
		}
		const replies = new RegExp(`^${repo}/pulls/(\\d+)/comments/(\\d+)/replies$`).exec(path);
		if (method === 'POST' && replies !== null) {
			const answered = this.lineCommentAt(Number(replies[2]));
			if (answered === undefined || answered.pull !== Number(replies[1])) return NOT_FOUND;
			const id = this.replyTo(answered.id, this.person, String(fields.body));
			const made = this.lineCommentAt(id);
			return made === undefined ? NOT_FOUND : ok(this.renderLineComment(made));
		}
		return undefined;
	}

	private renderLineComment(c: LineComment) {
		return {
			id: c.id,
			body: c.body,
			user: { login: c.login },
			created_at: c.createdAt,
			author_association: this.association(c.login),
			path: c.path,
			line: c.line,
			subject_type: 'line',
			...(c.inReplyTo === undefined ? {} : { in_reply_to_id: c.inReplyTo }),
			pull_request_url: `https://api.github.com/repos/${this.repo}/pulls/${String(c.pull)}`
		};
	}

	private renderReview(r: Review) {
		return {
			id: r.id,
			body: r.body,
			user: { login: r.login },
			state: r.state,
			submitted_at: r.submittedAt,
			author_association: this.association(r.login)
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
			created_at: this.createdAt(issue.number),
			labels: issue.labels.map((name) => ({ name })),
			assignees: issue.assignees.map((login) => ({ login })),
			user: { login: this.person },
			parent_issue_url: this.parentUrl(issue.number),
			sub_issues_summary: {
				total: issue.subIssues.length,
				completed: issue.subIssues.filter((n) => this.issues.get(n)?.state === 'closed').length
			},
			...(issue.pull ? { pull_request: { html_url: this.url(issue.number) } } : {})
		};
	}

	private parentUrl(number: number): string | null {
		const parent = [...this.issues.values()].find((i) => i.subIssues.includes(number));
		return parent === undefined
			? null
			: `https://api.github.com/repos/${this.repo}/issues/${String(parent.number)}`;
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
