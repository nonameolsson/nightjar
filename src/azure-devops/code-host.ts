// Azure Repos as a Code host: never completes, abandons or publishes a pull request, nor sets a work item's state (docs/adr/0002).
import { z } from 'zod';
import { failedCheckBody } from '../check-output.js';
import type {
	ChangeRequest,
	CodeHost,
	DraftRequest,
	FailedCheck,
	Feedback,
	NightjarDraft,
	OpenPull,
	Pull,
	PullChecks,
	PullCommit
} from '../code-host.js';
import { answerText, endsWithFooter, withFooter } from '../footer.js';
import { firstLine, type Env, type Run } from '../git.js';
import { logTail } from '../log-tail.js';
import type { TicketReference } from '../tracker.js';
import { BRANCH_PREFIX } from '../worktree.js';
import { AzureDevOpsFailure, type AzureDevOpsApi, type Sending } from './api.js';
import { workItem } from './tracker.js';
import { AzureTrust, IdentityRefSchema, type IdentityRef } from './trust.js';

// Runs git with `extra` added to its environment, which is how the sign-in reaches it.
export type AzureGitRunner = (args: readonly string[], cwd: string, extra: Env) => Promise<Run>;

// How a Ticket reference is placed: linked as a work item of the repo's own organization, or as body text.
export type ReferencesAs = 'work items' | 'text';

export interface AzureReposSettings {
	readonly project: string;
	readonly repo: string;
	readonly referencesAs: ReferencesAs;
	// factory.json's trusted list; when set it replaces the Contributors default
	readonly trusted?: readonly string[] | undefined;
	// factory.json's codeHost.trustedChecks: the names whose failed statuses count; when set it replaces Azure Pipelines
	readonly trustedChecks?: readonly string[] | undefined;
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
			iterationId: z.int().nullish(),
			creationDate: z.string().nullish(),
			updatedDate: z.string().nullish()
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
	// only within its thread
	id: z.int(),
	author: IdentityRefSchema.nullish(),
	content: z.string().nullish(),
	publishedDate: z.string().nullish(),
	// text, codeChange, or system for what Azure Repos writes itself, such as a vote or a push
	commentType: z.union([z.string(), z.number()]).nullish(),
	isDeleted: z.boolean().nullish()
});

const PositionSchema = z.looseObject({ line: z.int().nullish() }).nullish();

const ThreadSchema = z.looseObject({
	id: z.int(),
	isDeleted: z.boolean().nullish(),
	publishedDate: z.string().nullish(),
	// the file a line comment is on, and where its line is on the head push
	threadContext: z
		.looseObject({
			filePath: z.string().nullish(),
			rightFileStart: PositionSchema,
			leftFileStart: PositionSchema
		})
		.nullish(),
	// Azure Repos' own notes about a system thread, each as { $type, $value }
	properties: z.record(z.string(), z.unknown()).nullish(),
	comments: z.array(ThreadCommentSchema).nullish()
});

type Thread = z.infer<typeof ThreadSchema>;

const ThreadsSchema = z.looseObject({ value: z.array(ThreadSchema) });

const ReviewersSchema = z.looseObject({
	reviewers: z
		.array(
			z.looseObject({
				id: z.string(),
				vote: z.number().nullish(),
				uniqueName: z.string().nullish(),
				displayName: z.string().nullish()
			})
		)
		.nullish()
});

const DatedSchema = z.looseObject({ date: z.string().nullish() }).nullish();

const CommitsSchema = z.looseObject({
	value: z.array(
		z.looseObject({
			commitId: z.string(),
			comment: z.string().nullish(),
			// a list cuts a long message short; the commit itself has it whole
			commentTruncated: z.boolean().nullish(),
			author: DatedSchema,
			committer: DatedSchema
		})
	)
});

const CommitSchema = z.looseObject({ comment: z.string().nullish() });

const ConnectionSchema = z.looseObject({ authenticatedUser: z.looseObject({ id: z.string() }) });

// The policy type of a build validation policy, the same in every organization.
const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';

// The results Azure Pipelines shows as a red mark.
const RED = new Set(['failed', 'canceled', 'abandoned']);

const LISTED = 100;

// The most commits of one pull request that one read takes.
const COMMITS_PAGE = 500;

const system = (type: string | number | null | undefined) => type === 'system' || type === 3;

// Only a comment a person typed is feedback: not what Azure Repos writes for a push or a code change.
const typed = (type: string | number | null | undefined) =>
	type === undefined || type === null || type === 'text' || type === 1;

// What a reviewer's vote is worth, as Azure Repos numbers it.
const WAITING_FOR_AUTHOR = '-5';
const REJECTED = '-10';

// A vote is feedback when it is one of these, and a request for changes when it is waiting for author. A rejection is feedback a Go answers; Nightjar does not start a round on it by itself.
const FEEDBACK_VOTES: Readonly<Record<string, string>> = {
	[WAITING_FOR_AUTHOR]: 'Waiting for author',
	[REJECTED]: 'Rejected'
};

// What a pull request's thread carries in its properties when Azure Repos wrote it for a vote.
const VOTE_THREAD = 'VoteUpdate';

const FEEDBACK_ID = /^(comment|review|check):(.+)$/;

// Azure Repos names a status by its genre and name; the genre is the service that posted it.
const statusName = (s: Status) =>
	s.context.genre ? `${s.context.genre}/${s.context.name}` : s.context.name;

// Whether a comment or a vote's text has words of a person to answer: Nightjar's own and empty ones have none.
const hasWords = (text: string | null | undefined): text is string =>
	typeof text === 'string' && text.trim() !== '' && !endsWithFooter(text);

const byTime = (a: { at: string }, b: { at: string }) => a.at.localeCompare(b.at);

// A piece of feedback and where it sits on the pull request, so a reply can find its thread.
interface Located {
	readonly feedback: Feedback;
	// set for a comment: its thread and its place in it
	readonly thread?: number;
	readonly comment?: number;
}

// A vote Azure Repos noted in a thread of its own.
interface Vote {
	readonly thread: number;
	readonly result: string;
	readonly by: IdentityRef | null | undefined;
	readonly text: string | null | undefined;
	readonly at: string;
}

function propertyOf(thread: Thread, name: string): string | undefined {
	const parsed = z.looseObject({ $value: z.unknown() }).safeParse(thread.properties?.[name]);
	const value = parsed.success ? parsed.data.$value : undefined;
	return typeof value === 'string' ? value : undefined;
}

// A line comment's file, spelled from the repo's root, and its line; a line the head push no longer has is an older version's.
function placeOf(thread: Thread): Pick<Feedback, 'path' | 'line' | 'outdated'> {
	const file = thread.threadContext?.filePath;
	if (file == null) return {};
	const path = file.replace(/^\//, '');
	const where = thread.threadContext;
	const line = where?.rightFileStart?.line ?? where?.leftFileStart?.line;
	return line == null ? { path, outdated: true } : { path, line };
}

// Every vote of the pull request's threads, oldest first.
function votesIn(threads: readonly Thread[]): Vote[] {
	const votes: Vote[] = [];
	for (const t of threads) {
		if (propertyOf(t, 'CodeReviewThreadType') !== VOTE_THREAD) continue;
		const result = propertyOf(t, 'CodeReviewVoteResult');
		const first = (t.comments ?? []).find((c) => c.isDeleted !== true && system(c.commentType));
		if (result === undefined || first === undefined) continue;
		votes.push({
			thread: t.id,
			result,
			by: first.author,
			text: first.content,
			at: first.publishedDate ?? t.publishedDate ?? ''
		});
	}
	return votes;
}

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
	// the Tracker's rule for whose words reach the Coding agent
	private readonly trust: AzureTrust;
	// the lower-cased names whose failed statuses are feedback
	private readonly trustedChecks: ReadonlySet<string>;

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
		this.trust = new AzureTrust(api, settings.project, settings.trusted);
		this.trustedChecks = new Set(
			(settings.trustedChecks ?? ['Azure Pipelines']).map((name) => name.toLowerCase())
		);
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

	// The active pull requests from this repo's own branches, draft or not, oldest first: Azure Repos numbers pull requests as they are made.
	private async activePulls(
		what: string
	): Promise<{ id: number; branch: string; draft: boolean }[]> {
		const found: { id: number; branch: string; draft: boolean }[] = [];
		for (let skip = 0; ; skip += LISTED) {
			const query = new URLSearchParams({
				'searchCriteria.status': 'active',
				$top: String(LISTED),
				$skip: String(skip)
			});
			const page = await this.api.parse(
				what,
				{ method: 'GET', url: this.at(`pullrequests?${query.toString()}&${API}`) },
				ListedSchema
			);
			for (const p of page.value) {
				const branch = p.sourceRefName.replace(/^refs\/heads\//, '');
				if (p.forkSource != null || branch === p.sourceRefName) continue;
				found.push({ id: p.pullRequestId, branch, draft: p.isDraft === true });
			}
			if (page.value.length < LISTED) break;
		}
		return found.sort((a, b) => a.id - b.id);
	}

	// Open draft pull requests from this repo's own Nightjar branches, oldest first.
	async nightjarDrafts(): Promise<NightjarDraft[]> {
		const listed = await this.activePulls("list Nightjar's draft pull requests");
		const drafts: NightjarDraft[] = [];
		for (const { id, branch, draft } of listed) {
			if (draft && branch.startsWith(BRANCH_PREFIX)) drafts.push(await this.draft(id, branch));
		}
		return drafts;
	}

	// Open pull requests, draft or not, from this repo's own branches that start with `prefix`, oldest first.
	async openPulls(prefix: string): Promise<OpenPull[]> {
		const listed = await this.activePulls('list the open pull requests');
		const found: OpenPull[] = [];
		for (const { id, branch } of listed) {
			if (!branch.startsWith(prefix)) continue;
			const pull: Pull = { id, url: this.pullUrl(id) };
			found.push({
				pull,
				branch,
				// the list cuts a description short
				body: (await this.read(pull)).description ?? '',
				commits: await this.commits(pull),
				changesRequested: await this.changesRequested(pull)
			});
		}
		return found;
	}

	// The commits of a pull request's branch that its base lacks, oldest first, each with its whole message and its committer's time.
	private async commits(pull: Pull): Promise<PullCommit[]> {
		const n = String(pull.id);
		// one page: a branch with more commits than this is no branch for one run
		const got = await this.api.parse(
			`list the commits of pull request ${n}`,
			{
				method: 'GET',
				url: this.at(`pullRequests/${n}/commits?$top=${String(COMMITS_PAGE)}&${API}`)
			},
			CommitsSchema
		);
		const commits: PullCommit[] = [];
		for (const c of got.value) {
			const cut = c.commentTruncated === true;
			commits.push({
				message: cut ? await this.wholeMessage(c.commitId) : (c.comment ?? ''),
				at: c.committer?.date ?? c.author?.date ?? ''
			});
		}
		// by time, whichever way Azure Repos lists them
		return commits.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || 0);
	}

	private async wholeMessage(commitId: string): Promise<string> {
		const got = await this.api.parse(
			`read commit ${commitId.slice(0, 7)}`,
			{ method: 'GET', url: this.at(`commits/${encodeURIComponent(commitId)}?${API}`) },
			CommitSchema
		);
		return got.comment ?? '';
	}

	// Every vote of waiting for author, oldest first, as a request for changes.
	private async changesRequested(pull: Pull): Promise<ChangeRequest[]> {
		const found: ChangeRequest[] = [];
		for (const v of votesIn(await this.threads(pull))) {
			if (v.result !== WAITING_FOR_AUTHOR) continue;
			const { name, trusted } = await this.trust.person(v.by);
			found.push({ id: `review:${String(v.thread)}`, author: name, at: v.at, trusted });
		}
		return found;
	}

	// The last push to a pull request, which is its head.
	private async headPush(id: number) {
		const n = String(id);
		const pushes = await this.api.parse(
			`read the pushes to pull request ${n}`,
			{ method: 'GET', url: this.at(`pullRequests/${n}/iterations?${API}`) },
			IterationsSchema
		);
		return [...pushes.value].sort((a, b) => a.id - b.id).at(-1);
	}

	// The list cuts a description short, so each draft is read whole.
	private async draft(id: number, branch: string): Promise<NightjarDraft> {
		const n = String(id);
		const raw = await this.api.parse(
			`read pull request ${n}`,
			{ method: 'GET', url: this.at(`pullrequests/${n}?${API}`) },
			DraftSchema
		);
		const head = await this.headPush(id);
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
	private async latestStatuses(id: number, head: number | undefined): Promise<Status[]> {
		const got = await this.api.parse(
			`read the statuses of pull request ${String(id)}`,
			{ method: 'GET', url: this.at(`pullRequests/${String(id)}/statuses?${API}`) },
			StatusesSchema
		);
		const latest = new Map<string, Status>();
		for (const s of got.value) {
			if (head !== undefined && s.iterationId != null && s.iterationId !== head) continue;
			const known = latest.get(statusName(s));
			if (known === undefined || s.id > known.id) latest.set(statusName(s), s);
		}
		return [...latest.values()];
	}

	private async statusChecks(id: number, head: number | undefined): Promise<PullChecks> {
		const current = await this.latestStatuses(id, head);
		const red = current.filter((s) => s.state === 'failed' || s.state === 'error');
		return {
			pending: current.some((s) => s.state === 'pending'),
			failed: red.map((s) => alone(statusName(s), s.description ?? ''))
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
		const other = (id: string | null | undefined) => id != null && id.toLowerCase() !== me;
		if ((raw.reviewers ?? []).some((r) => (r.vote ?? 0) !== 0 && other(r.id))) return true;
		const live = await this.threads(this.toPull(raw));
		const comments = live.flatMap((t) => t.comments ?? []);
		const others = comments.filter((c) => c.isDeleted !== true && other(c.author?.id));
		return others.some((c) => !system(c.commentType));
	}

	// The threads of a pull request that were not deleted; Azure Repos answers all of them in one list.
	private async threads(pull: Pull): Promise<Thread[]> {
		const n = String(pull.id);
		const got = await this.api.parse(
			`read the comments on pull request ${n}`,
			{ method: 'GET', url: this.at(`pullRequests/${n}/threads?${API}`) },
			ThreadsSchema
		);
		return got.value.filter((t) => t.isDeleted !== true);
	}

	async feedback(pull: Pull): Promise<Feedback[]> {
		const found = (await this.located(pull)).map((l) => l.feedback);
		// stable, so what one moment shares stays in the order of the lists read
		return found.sort(byTime);
	}

	// Everything feedback and reply need: comments and votes from the threads, failed statuses of the head push.
	private async located(pull: Pull): Promise<Located[]> {
		const threads = await this.threads(pull);
		return [
			...(await this.commentsIn(threads)),
			...(await this.reviewsIn(pull, threads)),
			...(await this.failedStatuses(pull))
		];
	}

	// Each comment a person typed, in any thread: a line comment keeps its file and line.
	private async commentsIn(threads: readonly Thread[]): Promise<Located[]> {
		const found: Located[] = [];
		for (const t of threads) {
			const where = placeOf(t);
			for (const c of t.comments ?? []) {
				if (c.isDeleted === true || !typed(c.commentType) || !hasWords(c.content)) continue;
				const { name, trusted } = await this.trust.person(c.author);
				found.push({
					feedback: {
						id: `comment:${String(t.id)}.${String(c.id)}`,
						kind: 'comment',
						author: name,
						body: c.content,
						at: c.publishedDate ?? t.publishedDate ?? '',
						trusted,
						...where
					},
					thread: t.id,
					comment: c.id
				});
			}
		}
		return found;
	}

	// A vote of waiting for author or rejected is a review. Azure Repos notes each vote in a thread of its own; a vote it left no note of is read from the reviewer's current vote, with no time.
	private async reviewsIn(pull: Pull, threads: readonly Thread[]): Promise<Located[]> {
		const found: Located[] = [];
		const votes = votesIn(threads);
		for (const v of votes) {
			const label = FEEDBACK_VOTES[v.result];
			if (label === undefined) continue;
			const { name, trusted } = await this.trust.person(v.by);
			const body = v.text?.trim() ? v.text : `${name} voted ${label}`;
			if (!hasWords(body)) continue;
			found.push({
				feedback: {
					id: `review:${String(v.thread)}`,
					kind: 'review',
					author: name,
					body,
					at: v.at,
					trusted
				}
			});
		}
		const read = await this.api.parse(
			`read the reviewers of pull request ${String(pull.id)}`,
			{ method: 'GET', url: this.at(`pullrequests/${String(pull.id)}?${API}`) },
			ReviewersSchema
		);
		for (const r of read.reviewers ?? []) {
			const label = FEEDBACK_VOTES[String(r.vote ?? 0)];
			if (label === undefined) continue;
			const noted = votes.some(
				(v) => v.result === String(r.vote) && v.by?.id?.toLowerCase() === r.id.toLowerCase()
			);
			if (noted) continue;
			const { name, trusted } = await this.trust.person(r);
			found.push({
				feedback: {
					id: `review:${r.id.toLowerCase()}`,
					kind: 'review',
					author: name,
					body: `${name} voted ${label}`,
					at: '',
					trusted
				}
			});
		}
		return found;
	}

	// A failed status of the head push is a check. Its service is the genre it was posted under, else its name; only the names `trustedChecks` lists, else Azure Pipelines, are trusted.
	private async failedStatuses(pull: Pull): Promise<Located[]> {
		const head = await this.headPush(pull.id);
		const current = await this.latestStatuses(pull.id, head?.id);
		const found: Located[] = [];
		for (const s of current) {
			if (s.state !== 'failed' && s.state !== 'error') continue;
			found.push({
				feedback: {
					id: `check:${String(s.id)}`,
					kind: 'check',
					author: s.context.genre ? s.context.genre : s.context.name,
					body: failedCheckBody(statusName(s), s.description ?? ''),
					at: s.updatedDate ?? s.creationDate ?? '',
					trusted: this.trustedStatus(s)
				}
			});
		}
		return found;
	}

	// A status is trusted when the genre it was posted under, its name or both is on the list.
	private trustedStatus(s: Status): boolean {
		const names = [s.context.genre, s.context.name, statusName(s)];
		return names.some((n) => typeof n === 'string' && this.trustedChecks.has(n.toLowerCase()));
	}

	// A comment is answered in its own thread; anything else in a new thread on the pull request, quoting the start of what it answers.
	async reply(pull: Pull, feedbackId: string, body: string): Promise<void> {
		const n = String(pull.id);
		if (!FEEDBACK_ID.test(feedbackId)) {
			throw new AzureDevOpsFailure(`${feedbackId} is no id of feedback.`);
		}
		const found = (await this.located(pull)).find((l) => l.feedback.id === feedbackId);
		if (found === undefined) {
			throw new AzureDevOpsFailure(`Azure DevOps has no ${feedbackId} on pull request ${n}.`);
		}
		const { feedback, thread, comment } = found;
		if (thread === undefined || comment === undefined) {
			await this.comment(pull, answerText(feedback.body, body));
			return;
		}
		// a line comment's thread is the place for its answer; one in the conversation is quoted, as the thread may hold others
		const text = feedback.path === undefined ? answerText(feedback.body, body) : withFooter(body);
		await this.api.call(`reply to comment ${feedbackId}`, {
			method: 'POST',
			url: this.at(`pullRequests/${n}/threads/${String(thread)}/comments?${API}`),
			body: { content: text, parentCommentId: comment, commentType: 1 }
		});
	}
}
