// Azure Repos as a Code host: never completes, abandons or publishes a pull request, nor sets a work item's state (docs/adr/0002).
import { z } from 'zod';
import { failedCheckBody } from '../check-output.js';
import type {
	ChangeRequest,
	CodeHost,
	DraftRequest,
	Feedback,
	OpenPull,
	Pull
} from '../code-host.js';
import { answerText, endsWithFooter, withFooter } from '../footer.js';
import { firstLine, type Env, type Run } from '../git.js';
import type { TicketReference } from '../tracker.js';
import { AzureDevOpsFailure, type AzureDevOpsApi } from './api.js';
import { workItem } from './tracker.js';
import { AzureDevOpsTrust } from './trust.js';

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
	// factory.json's codeHost.trustedChecks: the apps whose failed statuses count besides Azure Pipelines
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

const IdentitySchema = z.looseObject({
	id: z.string().nullish(),
	uniqueName: z.string().nullish(),
	displayName: z.string().nullish()
});

type Identity = z.infer<typeof IdentitySchema>;

const ReviewerSchema = z.looseObject({ ...IdentitySchema.shape, vote: z.int().nullish() });

type Reviewer = z.infer<typeof ReviewerSchema>;

const ReviewedSchema = z.looseObject({ reviewers: z.array(ReviewerSchema).nullish() });

const OpenPullSchema = z.looseObject({
	...PullSchema.shape,
	...ReviewedSchema.shape,
	creationDate: z.string(),
	sourceRefName: z.string(),
	// only a pull request from a fork has one
	forkSource: z.unknown().optional()
});

const OpenPullsSchema = z.looseObject({ value: z.array(OpenPullSchema) });

// a line of a file, as a thread holds it
const PositionSchema = z.looseObject({ line: z.int() }).nullish();

const ThreadCommentSchema = z.looseObject({
	id: z.int(),
	content: z.string().nullish(),
	author: IdentitySchema.nullish(),
	publishedDate: z.string().nullish(),
	// `text` for a person's; `system` and `codeChange` are Azure DevOps's own
	commentType: z.string().nullish(),
	isDeleted: z.boolean().nullish()
});

type ThreadComment = z.infer<typeof ThreadCommentSchema>;

const ThreadSchema = z.looseObject({
	id: z.int(),
	isDeleted: z.boolean().nullish(),
	publishedDate: z.string().nullish(),
	comments: z.array(ThreadCommentSchema).nullish(),
	properties: z.record(z.string(), z.unknown()).nullish(),
	// a thread on a file; without a line it is on the whole file, or on a line the file lost
	threadContext: z
		.looseObject({
			filePath: z.string().nullish(),
			rightFileStart: PositionSchema,
			leftFileStart: PositionSchema
		})
		.nullish(),
	pullRequestThreadContext: z
		.looseObject({
			// where the thread was first made
			trackingCriteria: z
				.looseObject({ origRightFileStart: PositionSchema, origLeftFileStart: PositionSchema })
				.nullish()
		})
		.nullish()
});

type Thread = z.infer<typeof ThreadSchema>;

const ThreadsSchema = z.looseObject({ value: z.array(ThreadSchema) });

const StatusSchema = z.looseObject({
	id: z.int(),
	state: z.string(),
	description: z.string().nullish(),
	context: z.looseObject({ name: z.string(), genre: z.string().nullish() }),
	creationDate: z.string().nullish(),
	updatedDate: z.string().nullish(),
	createdBy: IdentitySchema.nullish()
});

type Status = z.infer<typeof StatusSchema>;

const StatusesSchema = z.looseObject({ value: z.array(StatusSchema) });

// The most `$top` Azure DevOps lists of pull requests that suits one call.
const PAGE = 100;

// What a status ends in when it is feedback; a pass, a pending one and one that does not apply say nothing to answer.
const FAILED = ['failed', 'error'];

// Statuses that Azure Pipelines posted are the repo's own pipelines.
const PIPELINES = 'azure pipelines';

// A vote at or under this asks the author for something: -5 is "waiting for author", -10 "rejected".
const ASKS = -5;

const VOTE_WORDS: Readonly<Record<number, string>> = {
	[-5]: 'Waiting for author',
	[-10]: 'Rejected'
};

const voteText = (name: string, vote: number) =>
	`${name} voted "${VOTE_WORDS[vote] ?? String(vote)}" on this pull request.`;

// `comment:<thread>.<comment>`: a comment's number is its place in its thread, so the thread names it apart.
const FEEDBACK_ID = /^(?:(comment):(\d+)\.(\d+)|(review|check):(\d+))$/;

const gone = (feedbackId: string, id: number) =>
	new AzureDevOpsFailure(`Azure Repos has no ${feedbackId} on pull request ${String(id)}.`);

const nameOf = (who: Identity | null | undefined): string =>
	who?.uniqueName ?? who?.displayName ?? '';

// The `$value` of a thread's property, which Azure DevOps wraps with its type.
function property(thread: Thread, name: string): string | undefined {
	const wrapped = z.looseObject({ $value: z.unknown() }).safeParse(thread.properties?.[name]);
	const value = wrapped.success ? wrapped.data.$value : undefined;
	return typeof value === 'string' ? value : undefined;
}

const isVoteUpdate = (thread: Thread): boolean =>
	property(thread, 'CodeReviewThreadType') === 'VoteUpdate';

// Whether a comment has words of a person to answer: Azure DevOps's own, Nightjar's own and empty ones have none.
function hasWords(c: ThreadComment): boolean {
	if (c.isDeleted === true) return false;
	if (c.commentType != null && c.commentType !== 'text') return false;
	const body = c.content ?? '';
	return body.trim() !== '' && !endsWithFooter(body);
}

const stamp = (c: ThreadComment, thread: Thread): string =>
	c.publishedDate ?? thread.publishedDate ?? '';

// What the Coding agent may know of where a thread sits: its file, and its line while the file still has it.
function placeOf(thread: Thread): Pick<Feedback, 'path' | 'line' | 'outdated'> {
	const context = thread.threadContext;
	// Azure DevOps names a file from the repo's root with a slash first
	const path = context?.filePath?.replace(/^\//, '');
	if (path == null || path === '') return {};
	const now = context?.rightFileStart?.line ?? context?.leftFileStart?.line;
	if (now !== undefined) return { path, line: now };
	const first = thread.pullRequestThreadContext?.trackingCriteria;
	const was = first?.origRightFileStart?.line ?? first?.origLeftFileStart?.line;
	// a thread on a whole file never had a line; one on a line the file lost had one
	return was === undefined ? { path } : { path, outdated: true };
}

// A reviewer's vote that asks for changes, with the thread Azure DevOps made of it.
interface Vote {
	readonly thread: number;
	readonly reviewer: Reviewer;
	readonly author: string;
	readonly vote: number;
	readonly at: string;
}

// Whether `thread` is the vote update of the reviewer with this id.
function votedBy(thread: Thread, id: string): boolean {
	const voter = property(thread, 'CodeReviewVotedByIdentity');
	return isVoteUpdate(thread) && voter?.toLowerCase() === id.toLowerCase();
}

function madeFirst(a: Thread, b: Thread): number {
	return (a.publishedDate ?? '').localeCompare(b.publishedDate ?? '') || a.id - b.id;
}

// Each reviewer whose current vote asks for changes, oldest first, by the newest thread of their votes.
function votesOf(threads: readonly Thread[], reviewers: readonly Reviewer[]): Vote[] {
	const found: Vote[] = [];
	for (const reviewer of reviewers) {
		const vote = reviewer.vote ?? 0;
		if (vote > ASKS || reviewer.id == null) continue;
		const voter = reviewer.id;
		const mine = threads.filter((t) => votedBy(t, voter)).sort(madeFirst);
		const last = mine[mine.length - 1];
		if (last === undefined) continue;
		found.push({
			thread: last.id,
			reviewer,
			author: nameOf(reviewer),
			vote,
			at: last.publishedDate ?? ''
		});
	}
	return found.sort((a, b) => a.at.localeCompare(b.at));
}

// The app that ran a status: its genre, else who posted it.
const appOf = (s: Status): string => s.context.genre ?? nameOf(s.createdBy);

const whenOf = (s: Status): string => s.updatedDate ?? s.creationDate ?? '';

function checkBody(s: Status): string {
	return failedCheckBody(s.context.name, s.description ?? '');
}

function postedFirst(a: Status, b: Status): number {
	return whenOf(a).localeCompare(whenOf(b)) || a.id - b.id;
}

// A status is replaced by a newer one of the same app and name.
function latest(statuses: readonly Status[]): Status[] {
	const newest = new Map<string, Status>();
	for (const s of [...statuses].sort(postedFirst)) {
		newest.set(`${appOf(s).toLowerCase()}\n${s.context.name}`, s);
	}
	return [...newest.values()];
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
	private readonly trust: AzureDevOpsTrust;
	private readonly trustedChecks: readonly string[];

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
		this.trust = new AzureDevOpsTrust(api, settings.project, settings.trusted);
		this.trustedChecks = (settings.trustedChecks ?? []).map((name) => name.toLowerCase());
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

	async openPulls(prefix: string): Promise<OpenPull[]> {
		const found: z.infer<typeof OpenPullSchema>[] = [];
		for (let skip = 0; ; skip += PAGE) {
			const page = await this.api.parse(
				'list the open pull requests',
				{
					method: 'GET',
					url: this.at(
						`pullrequests?searchCriteria.status=active&$top=${String(PAGE)}&$skip=${String(skip)}&${API}`
					)
				},
				OpenPullsSchema
			);
			found.push(...page.value);
			if (page.value.length < PAGE) break;
		}
		const named = `refs/heads/${prefix}`;
		const ours = found.filter((p) => p.sourceRefName.startsWith(named) && p.forkSource == null);
		const listed: OpenPull[] = [];
		for (const p of ours) {
			const threads = await this.threads(this.toPull(p));
			listed.push({
				...this.toPull(p),
				branch: p.sourceRefName.slice('refs/heads/'.length),
				openedAt: p.creationDate,
				changesRequested: await this.changesRequested(votesOf(threads, p.reviewers ?? []))
			});
		}
		return listed;
	}

	private async changesRequested(votes: readonly Vote[]): Promise<ChangeRequest[]> {
		const found: ChangeRequest[] = [];
		for (const v of votes) {
			found.push({ author: v.author, at: v.at, trusted: await this.isTrusted(v.reviewer) });
		}
		return found;
	}

	private async isTrusted(who: Identity): Promise<boolean> {
		const name = nameOf(who);
		return name !== '' && (await this.trust.isTrusted(name, who.id ?? null));
	}

	private async threads(pull: Pull): Promise<Thread[]> {
		const got = await this.api.parse(
			`read the threads of pull request ${String(pull.id)}`,
			{ method: 'GET', url: this.at(`pullRequests/${String(pull.id)}/threads?${API}`) },
			ThreadsSchema
		);
		return got.value.filter((t) => t.isDeleted !== true);
	}

	private async statuses(pull: Pull): Promise<Status[]> {
		const got = await this.api.parse(
			`read the statuses of pull request ${String(pull.id)}`,
			{ method: 'GET', url: this.at(`pullRequests/${String(pull.id)}/statuses?${API}`) },
			StatusesSchema
		);
		return got.value;
	}

	async feedback(pull: Pull): Promise<Feedback[]> {
		const threads = await this.threads(pull);
		const reviewed = await this.api.parse(
			`read the reviewers of pull request ${String(pull.id)}`,
			{ method: 'GET', url: this.at(`pullrequests/${String(pull.id)}?${API}`) },
			ReviewedSchema
		);
		const found = [
			...(await this.comments(threads)),
			...(await this.votes(votesOf(threads, reviewed.reviewers ?? []))),
			...(await this.failedChecks(pull))
		];
		// stable, so what one moment shares stays in the order of the lists above
		return found.sort((a, b) => a.at.localeCompare(b.at));
	}

	private async comments(threads: readonly Thread[]): Promise<Feedback[]> {
		const found: Feedback[] = [];
		for (const thread of threads) {
			for (const c of (thread.comments ?? []).filter(hasWords)) {
				found.push({
					id: `comment:${String(thread.id)}.${String(c.id)}`,
					kind: 'comment',
					author: nameOf(c.author),
					body: c.content ?? '',
					at: stamp(c, thread),
					trusted: await this.isTrusted(c.author ?? {}),
					...placeOf(thread)
				});
			}
		}
		return found;
	}

	private async votes(votes: readonly Vote[]): Promise<Feedback[]> {
		const found: Feedback[] = [];
		for (const v of votes) {
			found.push({
				id: `review:${String(v.thread)}`,
				kind: 'review',
				author: v.author,
				body: voteText(v.author, v.vote),
				at: v.at,
				trusted: await this.isTrusted(v.reviewer)
			});
		}
		return found;
	}

	private async failedChecks(pull: Pull): Promise<Feedback[]> {
		return latest(await this.statuses(pull))
			.filter((s) => FAILED.includes(s.state))
			.map((s): Feedback => {
				const app = appOf(s).toLowerCase();
				return {
					id: `check:${String(s.id)}`,
					kind: 'check',
					author: app,
					body: checkBody(s),
					at: whenOf(s),
					trusted: app === PIPELINES || this.trustedChecks.includes(app)
				};
			});
	}

	async reply(pull: Pull, feedbackId: string, body: string): Promise<void> {
		const named = FEEDBACK_ID.exec(feedbackId);
		if (named === null) throw new AzureDevOpsFailure(`${feedbackId} is no id of feedback.`);
		const [, inThread, threadId, commentId, kind, number] = named;
		if (inThread !== undefined) {
			const thread = (await this.threads(pull)).find((t) => t.id === Number(threadId));
			const answered = thread?.comments?.find((c) => c.id === Number(commentId));
			if (thread === undefined || answered === undefined || !hasWords(answered)) {
				throw gone(feedbackId, pull.id);
			}
			await this.api.call(`reply to ${feedbackId}`, {
				method: 'POST',
				url: this.at(
					`pullRequests/${String(pull.id)}/threads/${String(thread.id)}/comments?${API}`
				),
				body: { parentCommentId: answered.id, content: withFooter(body), commentType: 1 }
			});
			return;
		}
		// a vote or a status has no thread of its own to answer in, so the answer quotes it on the conversation
		await this.comment(pull, answerText(await this.answered(pull, kind, Number(number)), body));
	}

	// the text a reply on the conversation quotes, as feedback() gives it
	private async answered(pull: Pull, kind: string | undefined, number: number): Promise<string> {
		const feedbackId = `${kind ?? ''}:${String(number)}`;
		if (kind === 'check') {
			const status = (await this.statuses(pull)).find((s) => s.id === number);
			if (status === undefined) throw gone(feedbackId, pull.id);
			return checkBody(status);
		}
		const thread = (await this.threads(pull)).find((t) => t.id === number && isVoteUpdate(t));
		const vote = Number(thread === undefined ? NaN : property(thread, 'CodeReviewVoteResult'));
		if (thread === undefined || Number.isNaN(vote)) throw gone(feedbackId, pull.id);
		return voteText(nameOf(thread.comments?.[0]?.author), vote);
	}
}
