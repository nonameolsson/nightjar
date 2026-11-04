// Azure Repos as a Code host: never completes, abandons or publishes a pull request, nor sets a work item's state (docs/adr/0002).
import { z } from 'zod';
import type {
	CodeHost,
	DraftRequest,
	FailedCheck,
	NightjarDraft,
	Pull,
	PullChecks
} from '../code-host.js';
import { firstLine, type Env, type Run } from '../git.js';
import { logTail } from '../log-tail.js';
import type { TicketReference } from '../tracker.js';
import { BRANCH_PREFIX } from '../worktree.js';
import { AzureDevOpsFailure, type AzureDevOpsApi, type Sending } from './api.js';
import { workItem } from './tracker.js';

// Runs git with `extra` added to its environment, which is how the sign-in reaches it.
export type AzureGitRunner = (args: readonly string[], cwd: string, extra: Env) => Promise<Run>;

// How a Ticket reference is placed: linked as a work item of the repo's own organization, or as body text.
export type ReferencesAs = 'work items' | 'text';

export interface AzureReposSettings {
	readonly project: string;
	readonly repo: string;
	readonly referencesAs: ReferencesAs;
}

const API = 'api-version=7.1';

// Azure Repos keeps no more of a pull request's description than this.
export const DESCRIPTION_LIMIT = 4000;

// Everything after it in a body is the references Nightjar placed.
export const REFERENCES_MARK = '<!-- nightjar:references -->';

const CUT = '\n\n(Cut short: Azure Repos keeps 4000 characters of a description.)';

const PullSchema = z.looseObject({
	pullRequestId: z.int(),
	description: z.string().nullish(),
	artifactId: z.string().nullish(),
	repository: z.looseObject({
		id: z.string(),
		project: z.looseObject({ id: z.string() }).nullish()
	})
});

const PullsSchema = z.looseObject({ value: z.array(PullSchema) });

const LinkedSchema = z.looseObject({ value: z.array(z.looseObject({ id: z.coerce.string() })) });

const ListedSchema = z.looseObject({
	value: z.array(
		z.looseObject({
			pullRequestId: z.int(),
			isDraft: z.boolean().nullish(),
			sourceRefName: z.string(),
			// set when the source branch is in a fork
			forkSource: z.unknown().optional()
		})
	)
});

const ReviewerSchema = z.looseObject({ id: z.string(), vote: z.number().nullish() });

const DraftSchema = PullSchema.extend({
	repository: z.looseObject({ id: z.string(), project: z.looseObject({ id: z.string() }) }),
	lastMergeSourceCommit: z.looseObject({ commitId: z.string() }).nullish(),
	reviewers: z.array(ReviewerSchema).nullish()
});

type Draft = z.infer<typeof DraftSchema>;

// Each push to a pull request is an iteration; the last one is its head.
const IterationsSchema = z.looseObject({
	value: z.array(
		z.looseObject({
			id: z.int(),
			sourceRefCommit: z.looseObject({ commitId: z.string() }).nullish()
		})
	)
});

const StatusesSchema = z.looseObject({
	value: z.array(
		z.looseObject({
			id: z.int(),
			// notSet, pending, succeeded, failed, error or notApplicable
			state: z.string(),
			description: z.string().nullish(),
			context: z.looseObject({ name: z.string(), genre: z.string().nullish() }),
			// none when it was posted to the pull request, not to one push
			iterationId: z.int().nullish()
		})
	)
});

type Status = z.infer<typeof StatusesSchema>['value'][number];

// what a build validation policy shows of its build's failure
const PreviewSchema = z.looseObject({
	jobName: z.string().nullish(),
	taskName: z.string().nullish(),
	errors: z.array(z.looseObject({ message: z.string().nullish() })).nullish()
});

const BuildContextSchema = z.looseObject({
	buildId: z.int().nullish(),
	buildDefinitionName: z.string().nullish(),
	// the build ran on an earlier push
	isExpired: z.boolean().nullish(),
	buildOutputPreview: PreviewSchema.nullish()
});

type BuildContext = z.infer<typeof BuildContextSchema>;

const EvaluationsSchema = z.looseObject({
	value: z.array(
		z.looseObject({
			// queued, running, approved, rejected, notApplicable or broken
			status: z.string().nullish(),
			configuration: z.looseObject({
				type: z.looseObject({ id: z.string() }),
				settings: z.looseObject({ displayName: z.string().nullish() }).nullish()
			}),
			context: BuildContextSchema.nullish()
		})
	)
});

const IssueSchema = z.looseObject({ type: z.string().nullish(), message: z.string().nullish() });

const RecordSchema = z.looseObject({
	id: z.string(),
	parentId: z.string().nullish(),
	// Stage, Phase, Job, Task or Checkpoint
	type: z.string(),
	name: z.string(),
	result: z.string().nullish(),
	order: z.number().nullish(),
	log: z.looseObject({ id: z.int() }).nullish(),
	issues: z.array(IssueSchema).nullish()
});

type TimelineRecord = z.infer<typeof RecordSchema>;

const TimelineSchema = z.looseObject({ records: z.array(RecordSchema).nullish() });

const timelineOf = (text: string) => TimelineSchema.parse(JSON.parse(text));

// a build log asked for as JSON: its lines
const LogLinesSchema = z.looseObject({ value: z.array(z.string()) });

const ThreadCommentSchema = z.looseObject({
	author: z.looseObject({ id: z.string() }).nullish(),
	// text, codeChange, or system for what Azure Repos writes itself, such as a vote or a push
	commentType: z.union([z.string(), z.number()]).nullish(),
	isDeleted: z.boolean().nullish()
});

const ThreadSchema = z.looseObject({
	isDeleted: z.boolean().nullish(),
	comments: z.array(ThreadCommentSchema).nullish()
});

const ThreadsSchema = z.looseObject({ value: z.array(ThreadSchema) });

const ConnectionSchema = z.looseObject({ authenticatedUser: z.looseObject({ id: z.string() }) });

// The policy type of a build validation policy, the same in every organization.
const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';

// The results Azure Pipelines shows as a red mark.
const RED = new Set(['failed', 'canceled', 'abandoned']);

const LISTED = 100;

const system = (type: string | number | null | undefined) => type === 'system' || type === 3;

// a Pull check that names no job
const alone = (check: string, logTail: string): FailedCheck => ({
	check,
	job: '',
	step: '',
	logTail
});

const lines = (...texts: (string | null | undefined)[]) =>
	texts.filter((t): t is string => typeof t === 'string' && t.trim() !== '').join('\n');

// Asked for as JSON, a build log is its lines; else it is the text itself.
function logText(text: string): string {
	try {
		const parsed = LogLinesSchema.safeParse(JSON.parse(text));
		if (parsed.success) return parsed.data.value.join('\n');
	} catch {
		// plain text
	}
	return text;
}

// The record that failed, before one that was only cancelled, in the order the build ran them.
function firstRed(records: readonly TimelineRecord[]): TimelineRecord | undefined {
	const ran = [...records].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	return ran.find((r) => r.result === 'failed') ?? ran.find((r) => RED.has(r.result ?? ''));
}

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

// The body with its references, cut to what Azure Repos keeps; the references are never cut.
function join(text: string, lines: readonly string[]): string {
	const tail = lines.length === 0 ? '' : `\n\n${REFERENCES_MARK}\n${lines.join('\n')}`;
	if (text.length + tail.length <= DESCRIPTION_LIMIT) return `${text}${tail}`;
	return `${text.slice(0, Math.max(0, DESCRIPTION_LIMIT - tail.length - CUT.length)).trimEnd()}${CUT}${tail}`;
}

export class AzureReposCodeHost implements CodeHost {
	private readonly project: string;
	private readonly repo: string;
	// where git pushes: the repo on Azure DevOps
	private readonly remote: string;
	// a finished build's failure never changes, so its timeline and log are read once
	private readonly builds = new Map<number, Omit<FailedCheck, 'check'>>();
	// the signed-in identity's id, read once
	private signedInId: Promise<string> | undefined;

	constructor(
		private readonly api: AzureDevOpsApi,
		private readonly settings: AzureReposSettings,
		private readonly git: AzureGitRunner,
		// a spec pushes to a folder instead
		remote?: string
	) {
		this.project = encodeURIComponent(settings.project);
		this.repo = encodeURIComponent(settings.repo);
		this.remote = remote ?? api.at(`${this.project}/_git/${this.repo}`);
	}

	private at(path: string): string {
		return this.api.at(`${this.project}/_apis/git/repositories/${this.repo}/${path}`);
	}

	private pullUrl(id: number): string {
		return this.api.at(`${this.project}/_git/${this.repo}/pullrequest/${String(id)}`);
	}

	private toPull = (raw: z.infer<typeof PullSchema>): Pull => ({
		id: raw.pullRequestId,
		url: this.pullUrl(raw.pullRequestId)
	});

	// Reads the repo, so a run that cannot reach it stops before it builds anything.
	async check(): Promise<void> {
		await this.api.call(`read the repo ${this.settings.repo}`, {
			method: 'GET',
			url: this.api.at(`${this.project}/_apis/git/repositories/${this.repo}?${API}`)
		});
	}

	// The sign-in rides in git's environment as a header for Azure DevOps alone, never in a URL or a config file.
	private async signedIn(): Promise<Env> {
		return {
			GIT_TERMINAL_PROMPT: '0',
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: 'http.https://dev.azure.com/.extraHeader',
			GIT_CONFIG_VALUE_0: `Authorization: ${await this.api.signIn.authorization()}`,
			// no credential helper asks a person for a password, or stores one
			GIT_CONFIG_KEY_1: 'credential.helper',
			GIT_CONFIG_VALUE_1: ''
		};
	}

	async push(folder: string, branch: string): Promise<void> {
		const args = ['push', '-q', this.remote, `HEAD:refs/heads/${branch}`];
		let got = await this.git(args, folder, await this.signedIn());
		if (got.missing) throw new AzureDevOpsFailure('git is not on the PATH.');
		if (!got.ok) {
			// a token from az lasts an hour, and a run may outlast it
			await this.api.signIn.refresh();
			got = await this.git(args, folder, await this.signedIn());
		}
		if (!got.ok) {
			throw new AzureDevOpsFailure(
				`git could not push ${branch} to Azure Repos: ${firstLine(got.err)}`
			);
		}
	}

	async openPull(branch: string): Promise<Pull | null> {
		const query = new URLSearchParams({
			'searchCriteria.sourceRefName': `refs/heads/${branch}`,
			'searchCriteria.status': 'active'
		});
		const got = await this.api.parse(
			`find the pull request of ${branch}`,
			{ method: 'GET', url: this.at(`pullrequests?${query.toString()}&${API}`) },
			PullsSchema
		);
		const first = got.value[0];
		return first ? this.toPull(first) : null;
	}

	async createDraft(request: DraftRequest): Promise<Pull> {
		const made = await this.api.parse(
			`open a pull request for ${request.head}`,
			{
				method: 'POST',
				url: this.at(`pullrequests?${API}`),
				body: {
					sourceRefName: `refs/heads/${request.head}`,
					targetRefName: `refs/heads/${request.base}`,
					title: request.title,
					description: join(request.body.trimEnd(), []),
					isDraft: true
				}
			},
			PullSchema
		);
		return this.toPull(made);
	}

	private read(pull: Pull) {
		return this.api.parse(
			`read pull request ${String(pull.id)}`,
			{ method: 'GET', url: this.at(`pullrequests/${String(pull.id)}?${API}`) },
			PullSchema
		);
	}

	private async setBody(pull: Pull, description: string): Promise<void> {
		await this.api.call(`update pull request ${String(pull.id)}`, {
			method: 'PATCH',
			url: this.at(`pullrequests/${String(pull.id)}?${API}`),
			body: { description }
		});
	}

	async editBody(pull: Pull, body: string): Promise<void> {
		const { lines } = split((await this.read(pull)).description ?? '');
		await this.setBody(pull, join(body.trimEnd(), lines));
	}

	async placeReferences(pull: Pull, references: readonly TicketReference[]): Promise<void> {
		if (this.settings.referencesAs === 'work items') {
			await this.linkWorkItems(pull, references);
			return;
		}
		const { text, lines } = split((await this.read(pull)).description ?? '');
		const added = references.map((r) => `- ${r.text}`).filter((l) => !lines.includes(l));
		if (added.length === 0) return;
		await this.setBody(pull, join(text, [...new Set([...lines, ...added])]));
	}

	// Links each work item not linked yet, through an artifact link on the work item, as Azure Repos does itself.
	private async linkWorkItems(pull: Pull, references: readonly TicketReference[]): Promise<void> {
		if (references.length === 0) return;
		const raw = await this.read(pull);
		const artifact =
			raw.artifactId ??
			`vstfs:///Git/PullRequestId/${raw.repository.project?.id ?? ''}%2F${raw.repository.id}%2F${String(raw.pullRequestId)}`;
		const linked = await this.api.parse(
			`read the work items of pull request ${String(pull.id)}`,
			{ method: 'GET', url: this.at(`pullRequests/${String(pull.id)}/workitems?${API}`) },
			LinkedSchema
		);
		const done = new Set(linked.value.map((w) => w.id));
		for (const { id } of references) {
			if (done.has(id)) continue;
			done.add(id);
			await this.api.call(`link work item ${id} to pull request ${String(pull.id)}`, {
				method: 'PATCH',
				url: this.api.at(`_apis/wit/workitems/${String(workItem(id))}?${API}`),
				contentType: 'application/json-patch+json',
				body: [
					{
						op: 'add',
						path: '/relations/-',
						value: { rel: 'ArtifactLink', url: artifact, attributes: { name: 'Pull Request' } }
					}
				]
			});
		}
	}

	async comment(pull: Pull, body: string): Promise<void> {
		await this.api.call(`comment on pull request ${String(pull.id)}`, {
			method: 'POST',
			url: this.at(`pullRequests/${String(pull.id)}/threads?${API}`),
			body: { comments: [{ parentCommentId: 0, content: body, commentType: 1 }] }
		});
	}

	// Open draft pull requests from this repo's own Nightjar branches, oldest first.
	async nightjarDrafts(): Promise<NightjarDraft[]> {
		const listed = new Map<number, string>();
		for (let skip = 0; ; skip += LISTED) {
			const query = new URLSearchParams({
				'searchCriteria.status': 'active',
				$top: String(LISTED),
				$skip: String(skip)
			});
			const page = await this.api.parse(
				"list Nightjar's draft pull requests",
				{ method: 'GET', url: this.at(`pullrequests?${query.toString()}&${API}`) },
				ListedSchema
			);
			for (const p of page.value) {
				const branch = p.sourceRefName.replace(/^refs\/heads\//, '');
				if (p.isDraft !== true || p.forkSource != null) continue;
				if (branch === p.sourceRefName || !branch.startsWith(BRANCH_PREFIX)) continue;
				listed.set(p.pullRequestId, branch);
			}
			if (page.value.length < LISTED) break;
		}
		const drafts: NightjarDraft[] = [];
		// Azure Repos numbers pull requests as they are made
		for (const [id, branch] of [...listed].sort(([a], [b]) => a - b)) {
			drafts.push(await this.draft(id, branch));
		}
		return drafts;
	}

	// The list cuts a description short, so each draft is read whole.
	private async draft(id: number, branch: string): Promise<NightjarDraft> {
		const n = String(id);
		const raw = await this.api.parse(
			`read pull request ${n}`,
			{ method: 'GET', url: this.at(`pullrequests/${n}?${API}`) },
			DraftSchema
		);
		const pushes = await this.api.parse(
			`read the pushes to pull request ${n}`,
			{ method: 'GET', url: this.at(`pullRequests/${n}/iterations?${API}`) },
			IterationsSchema
		);
		const head = [...pushes.value].sort((a, b) => a.id - b.id).at(-1);
		const statuses = await this.statusChecks(id, head?.id);
		const policies = await this.policyChecks(raw);
		return {
			pull: this.toPull(raw),
			branch,
			headCommit: head?.sourceRefCommit?.commitId ?? raw.lastMergeSourceCommit?.commitId ?? '',
			body: raw.description ?? '',
			checks: {
				pending: statuses.pending || policies.pending,
				failed: [...policies.failed, ...statuses.failed]
			},
			personEngaged: await this.personEngaged(raw)
		};
	}

	// The latest status of each name, on the head push or on the pull request itself.
	private async statusChecks(id: number, head: number | undefined): Promise<PullChecks> {
		const got = await this.api.parse(
			`read the statuses of pull request ${String(id)}`,
			{ method: 'GET', url: this.at(`pullRequests/${String(id)}/statuses?${API}`) },
			StatusesSchema
		);
		const named = (s: Status) =>
			s.context.genre ? `${s.context.genre}/${s.context.name}` : s.context.name;
		const latest = new Map<string, Status>();
		for (const s of got.value) {
			if (head !== undefined && s.iterationId != null && s.iterationId !== head) continue;
			const known = latest.get(named(s));
			if (known === undefined || s.id > known.id) latest.set(named(s), s);
		}
		const current = [...latest.values()];
		const red = current.filter((s) => s.state === 'failed' || s.state === 'error');
		return {
			pending: current.some((s) => s.state === 'pending'),
			failed: red.map((s) => alone(named(s), s.description ?? ''))
		};
	}

	// The build validation policies; a reviewer or work item policy is no Pull check.
	private async policyChecks(raw: Draft): Promise<PullChecks> {
		const artifact = `vstfs:///CodeReview/CodeReviewId/${raw.repository.project.id}/${String(raw.pullRequestId)}`;
		const got = await this.api.parse(
			`read the policies of pull request ${String(raw.pullRequestId)}`,
			{
				method: 'GET',
				url: this.api.at(
					`${this.project}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifact)}&api-version=7.1-preview.1`
				)
			},
			EvaluationsSchema
		);
		let pending = false;
		const failed: FailedCheck[] = [];
		for (const e of got.value) {
			if (e.configuration.type.id.toLowerCase() !== BUILD_POLICY) continue;
			const status = e.status ?? '';
			// a build of an earlier push says nothing of the head
			const stale = status !== 'notApplicable' && e.context?.isExpired === true;
			if (status === 'queued' || status === 'running' || stale) {
				pending = true;
			} else if (status === 'rejected' || status === 'broken') {
				const check =
					e.configuration.settings?.displayName?.trim() ||
					e.context?.buildDefinitionName?.trim() ||
					'Build';
				failed.push(await this.failedBuild(check, e.context ?? {}));
			}
		}
		return { pending, failed };
	}

	// A build names its failed job, failed step and log; one that cannot be read, what the policy says of it.
	private async failedBuild(check: string, context: BuildContext): Promise<FailedCheck> {
		const preview = context.buildOutputPreview;
		const said: FailedCheck = {
			check,
			job: preview?.jobName ?? '',
			step: preview?.taskName ?? '',
			logTail: lines(...(preview?.errors ?? []).map((e) => e.message))
		};
		const buildId = context.buildId;
		if (buildId == null) return said;
		const known = this.builds.get(buildId);
		if (known) return { check, ...known };
		const build = `${this.project}/_apis/build/builds/${String(buildId)}`;
		const timeline = await this.quietly(`${build}/timeline?${API}`, timelineOf);
		if (timeline === null) return said;
		const records = timeline.records ?? [];
		const job = firstRed(records.filter((r) => r.type === 'Job'));
		if (job === undefined) return said;
		const step = firstRed(records.filter((r) => r.type === 'Task' && r.parentId === job.id));
		const logId = (step ?? job).log?.id;
		let log: string | null = null;
		if (logId != null) log = await this.quietly(`${build}/logs/${String(logId)}?${API}`, logText);
		const issues = [step, job].flatMap((r) => r?.issues ?? []);
		const errors = lines(...issues.filter((i) => i.type === 'error').map((i) => i.message));
		const failure = {
			job: job.name,
			step: step?.name ?? '',
			// an expired log, or a token that may not read it, leaves the errors the build reported
			logTail: log !== null && log.trim() !== '' ? logTail(log) : errors || said.logTail
		};
		this.builds.set(buildId, failure);
		return { check, ...failure };
	}

	// A read whose failure leaves the Pull check named less fully, not the pass stopped.
	private async quietly<T>(path: string, read: (text: string) => T): Promise<T | null> {
		const sending: Sending = { method: 'GET', url: this.api.at(path) };
		try {
			return read(await this.api.text('read a build', sending));
		} catch {
			return null;
		}
	}

	// the identity Azure DevOps is signed in as, which is Nightjar's own
	private me(): Promise<string> {
		if (this.signedInId === undefined) {
			const got = this.api
				.parse(
					'read the signed-in person',
					{ method: 'GET', url: this.api.at(`_apis/connectionData?${API}-preview`) },
					ConnectionSchema
				)
				.then((c) => c.authenticatedUser.id.toLowerCase());
			this.signedInId = got;
			// a read that failed is forgotten, so the next asks again
			got.catch(() => {
				this.signedInId = undefined;
			});
		}
		return this.signedInId;
	}

	// A vote, or a comment that Azure Repos did not write itself, by any identity but the signed-in one.
	private async personEngaged(raw: Draft): Promise<boolean> {
		const me = await this.me();
		const other = (id: string | undefined) => id !== undefined && id.toLowerCase() !== me;
		if ((raw.reviewers ?? []).some((r) => (r.vote ?? 0) !== 0 && other(r.id))) return true;
		const n = String(raw.pullRequestId);
		const threads = await this.api.parse(
			`read the comments on pull request ${n}`,
			{ method: 'GET', url: this.at(`pullRequests/${n}/threads?${API}`) },
			ThreadsSchema
		);
		const live = threads.value.filter((t) => t.isDeleted !== true);
		const comments = live.flatMap((t) => t.comments ?? []);
		const others = comments.filter((c) => c.isDeleted !== true && other(c.author?.id));
		return others.some((c) => !system(c.commentType));
	}
}
