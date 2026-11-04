// GitHub as a Code host: the branch goes to origin and each Ticket reference into the draft pull request.
import { z } from 'zod';
import type {
	CodeHost,
	DraftRequest,
	FailedCheck,
	NightjarDraft,
	Pull,
	PullChecks
} from '../code-host.js';
import { firstLine, type Run } from '../git.js';
import { logTail } from '../log-tail.js';
import type { TicketReference } from '../tracker.js';
import { BRANCH_PREFIX } from '../worktree.js';
import { GitHubApi, GitHubFailure, PAGE, type GhRunner } from './api.js';

export type GitRunner = (args: readonly string[], cwd: string) => Promise<Run>;

const PullSchema = z.looseObject({
	number: z.int(),
	html_url: z.string(),
	body: z.string().nullable().optional()
});

const ListedPullSchema = PullSchema.extend({
	draft: z.boolean().optional(),
	head: z.looseObject({
		ref: z.string(),
		sha: z.string(),
		// null when the fork it came from is gone
		repo: z.looseObject({ full_name: z.string() }).nullable().optional()
	})
});

const CheckRunsSchema = z.looseObject({
	check_runs: z.array(
		z.looseObject({
			id: z.int(),
			name: z.string(),
			// queued, in_progress, completed, and waiting, requested or pending
			status: z.string(),
			conclusion: z.string().nullable().optional(),
			app: z.looseObject({ slug: z.string() }).nullable().optional(),
			output: z
				.looseObject({
					title: z.string().nullable().optional(),
					summary: z.string().nullable().optional()
				})
				.nullable()
				.optional()
		})
	)
});

type CheckRun = z.infer<typeof CheckRunsSchema>['check_runs'][number];

// The combined status: the latest status of each context.
const StatusesSchema = z.looseObject({
	statuses: z.array(
		z.looseObject({
			context: z.string(),
			// error, failure, pending or success
			state: z.string(),
			description: z.string().nullable().optional()
		})
	)
});

const JobSchema = z.looseObject({
	name: z.string(),
	workflow_name: z.string().nullable().optional(),
	steps: z
		.array(z.looseObject({ name: z.string(), conclusion: z.string().nullable().optional() }))
		.nullable()
		.optional()
});

// a review or a comment; a deleted account is null
const AuthoredSchema = z.array(
	z.looseObject({ user: z.looseObject({ login: z.string() }).nullable() })
);

const UserSchema = z.looseObject({ login: z.string() });

// The conclusions GitHub shows as a red mark on the pull request.
const RED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required']);

// The app that runs GitHub Actions; its check run's id is the job's id.
const ACTIONS = 'github-actions';

const lines = (...texts: (string | null | undefined)[]) =>
	texts.filter((t): t is string => typeof t === 'string' && t.trim() !== '').join('\n');

// Everything after it in a body is the references Nightjar placed.
const REFERENCES_MARK = '<!-- nightjar:references -->';

// A GitHub issue, #N, gets `Closes` so GitHub closes it on merge; any other Tracker's reference, such as AB#N, stays as written.
const placed = (r: TicketReference) => (/^#\d+$/.test(r.text) ? `Closes ${r.text}` : r.text);

const toPull = (raw: z.infer<typeof PullSchema>): Pull => ({ id: raw.number, url: raw.html_url });

function split(body: string): { text: string; lines: string[] } {
	const at = body.indexOf(REFERENCES_MARK);
	if (at < 0) return { text: body.trimEnd(), lines: [] };
	const lines = body
		.slice(at + REFERENCES_MARK.length)
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '');
	return { text: body.slice(0, at).trimEnd(), lines };
}

const join = (text: string, lines: readonly string[]) =>
	lines.length === 0 ? text : `${text}\n\n${REFERENCES_MARK}\n${lines.join('\n')}`;

export class GitHubCodeHost implements CodeHost {
	private readonly api: GitHubApi;
	// a finished job's failure never changes, so its log is read once
	private readonly jobs = new Map<number, FailedCheck>();
	// the signed-in login, read once
	private signedIn: Promise<string> | undefined;

	constructor(
		readonly repo: string,
		gh: GhRunner,
		private readonly git: GitRunner
	) {
		this.api = new GitHubApi(repo, gh);
	}

	async push(folder: string, branch: string): Promise<void> {
		const got = await this.git(['push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`], folder);
		if (got.missing) throw new GitHubFailure('git is not on the PATH.');
		if (!got.ok) throw new GitHubFailure(`git could not push ${branch}: ${firstLine(got.err)}`);
	}

	async openPull(branch: string): Promise<Pull | null> {
		const owner = this.repo.split('/')[0] ?? '';
		const query = new URLSearchParams({ head: `${owner}:${branch}`, state: 'open' });
		const raw = await this.api.parse(
			`find the pull request of ${branch}`,
			[`repos/${this.repo}/pulls?${query.toString()}`],
			z.array(PullSchema)
		);
		const first = raw[0];
		return first ? toPull(first) : null;
	}

	async createDraft(request: DraftRequest): Promise<Pull> {
		const made = await this.api.parse(
			`open a pull request for ${request.head}`,
			[
				'-X',
				'POST',
				`repos/${this.repo}/pulls`,
				'-f',
				`title=${request.title}`,
				'-f',
				`head=${request.head}`,
				'-f',
				`base=${request.base}`,
				'-f',
				`body=${request.body}`,
				'-F',
				'draft=true'
			],
			PullSchema
		);
		return toPull(made);
	}

	private async body(pull: Pull): Promise<string> {
		const n = String(pull.id);
		const raw = await this.api.parse(
			`read pull request #${n}`,
			[`repos/${this.repo}/pulls/${n}`],
			PullSchema
		);
		return raw.body ?? '';
	}

	private async setBody(pull: Pull, body: string): Promise<void> {
		const n = String(pull.id);
		await this.api.call(`update pull request #${n}`, [
			'-X',
			'PATCH',
			`repos/${this.repo}/pulls/${n}`,
			'-f',
			`body=${body}`
		]);
	}

	async editBody(pull: Pull, body: string): Promise<void> {
		const { lines } = split(await this.body(pull));
		await this.setBody(pull, join(body.trimEnd(), lines));
	}

	async placeReferences(pull: Pull, references: readonly TicketReference[]): Promise<void> {
		const { text, lines } = split(await this.body(pull));
		const added = references.map(placed).filter((l) => !lines.includes(l));
		if (added.length === 0) return;
		await this.setBody(pull, join(text, [...lines, ...added]));
	}

	async comment(pull: Pull, body: string): Promise<void> {
		const n = String(pull.id);
		await this.api.call(`comment on pull request #${n}`, [
			'-X',
			'POST',
			`repos/${this.repo}/issues/${n}/comments`,
			'-f',
			`body=${body}`
		]);
	}

	// Open draft pull requests from this repo's own Nightjar branches, oldest first.
	async nightjarDrafts(): Promise<NightjarDraft[]> {
		const query = new URLSearchParams({ state: 'open', sort: 'created', direction: 'asc' });
		const raw = await this.api.parse(
			"list Nightjar's draft pull requests",
			[`repos/${this.repo}/pulls?${query.toString()}&${PAGE}`],
			z.array(ListedPullSchema)
		);
		const own = (full: string | undefined) => full?.toLowerCase() === this.repo.toLowerCase();
		const drafts: NightjarDraft[] = [];
		for (const p of raw) {
			if (p.draft !== true || !p.head.ref.startsWith(BRANCH_PREFIX)) continue;
			if (!own(p.head.repo?.full_name)) continue;
			const pull = toPull(p);
			drafts.push({
				pull,
				branch: p.head.ref,
				headCommit: p.head.sha,
				body: p.body ?? '',
				checks: await this.pullChecks(p.head.sha),
				personEngaged: await this.personEngaged(pull)
			});
		}
		return drafts;
	}

	// The check runs and commit statuses on `sha`.
	private async pullChecks(sha: string): Promise<PullChecks> {
		const commit = `repos/${this.repo}/commits/${sha}`;
		const short = sha.slice(0, 7);
		const runs = await this.api.parse(
			`read the check runs of ${short}`,
			[`${commit}/check-runs?filter=latest&${PAGE}`],
			CheckRunsSchema
		);
		const statuses = await this.api.parse(
			`read the commit statuses of ${short}`,
			[`${commit}/status?${PAGE}`],
			StatusesSchema
		);
		const pending =
			runs.check_runs.some((r) => r.status !== 'completed') ||
			statuses.statuses.some((s) => s.state === 'pending');
		const failed: FailedCheck[] = [];
		for (const r of runs.check_runs) {
			if (r.status === 'completed' && RED.has(r.conclusion ?? '')) {
				failed.push(await this.failedRun(r));
			}
		}
		for (const s of statuses.statuses) {
			if (s.state === 'failure' || s.state === 'error') {
				failed.push({ check: s.context, job: '', step: '', logTail: s.description ?? '' });
			}
		}
		return { pending, failed };
	}

	// An Actions job names its workflow, failed step and log; any other app's check run only itself.
	private async failedRun(r: CheckRun): Promise<FailedCheck> {
		const alone = {
			check: r.name,
			job: '',
			step: '',
			logTail: lines(r.output?.title, r.output?.summary)
		};
		if (r.app?.slug !== ACTIONS) return alone;
		const known = this.jobs.get(r.id);
		if (known) return known;
		const job = await this.read(`repos/${this.repo}/actions/jobs/${String(r.id)}`, JobSchema);
		if (job === null) return alone;
		const log = await this.api.raw([`repos/${this.repo}/actions/jobs/${String(r.id)}/logs`]);
		const workflow = job.workflow_name ?? '';
		const failure: FailedCheck = {
			check: workflow === '' ? job.name : `${workflow} / ${job.name}`,
			job: job.name,
			step: (job.steps ?? []).find((s) => RED.has(s.conclusion ?? ''))?.name ?? '',
			// an expired log, or a token that may not read it, leaves what the check run says
			logTail: log.ok && log.out.trim() !== '' ? logTail(log.out) : alone.logTail
		};
		this.jobs.set(r.id, failure);
		return failure;
	}

	// A call whose failure leaves the Pull check named less fully, not the pass stopped.
	private async read<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
		const got = await this.api.raw([path]);
		if (!got.ok) return null;
		try {
			const parsed = schema.safeParse(JSON.parse(got.out));
			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	}

	// the login gh is signed in as, which is Nightjar's own
	private login(): Promise<string> {
		if (this.signedIn === undefined) {
			const user = this.api.parse('read the signed-in account', ['user'], UserSchema);
			this.signedIn = user.then((u) => u.login);
		}
		return this.signedIn;
	}

	// A review or comment by any login but the signed-in one; an inline comment is part of a review.
	private async personEngaged(pull: Pull): Promise<boolean> {
		const me = await this.login();
		const n = String(pull.id);
		const reviews = await this.api.parse(
			`read the reviews of pull request #${n}`,
			[`repos/${this.repo}/pulls/${n}/reviews?${PAGE}`],
			AuthoredSchema
		);
		const comments = await this.api.parse(
			`read the comments on pull request #${n}`,
			[`repos/${this.repo}/issues/${n}/comments?${PAGE}`],
			AuthoredSchema
		);
		return [...reviews, ...comments].some((a) => a.user?.login !== me);
	}
}
