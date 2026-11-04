// GitHub as a Code host: the branch goes to origin and each Ticket reference into the draft pull request.
import { z } from 'zod';
import { failedCheckBody } from '../check-output.js';
import type { CodeHost, DraftRequest, Feedback, Pull } from '../code-host.js';
import { answerText, endsWithFooter, withFooter } from '../footer.js';
import { firstLine, type Run } from '../git.js';
import type { TicketReference } from '../tracker.js';
import { GitHubApi, GitHubFailure, type GhRunner } from './api.js';
import { GitHubTrust } from './trust.js';

export type GitRunner = (args: readonly string[], cwd: string) => Promise<Run>;

export interface GitHubCodeHostOptions {
	// factory.json's trusted list; when set it replaces the write-access default
	readonly trusted?: readonly string[] | undefined;
	// factory.json's codeHost.trustedChecks: app slugs whose failed checks count besides GitHub Actions
	readonly trustedChecks?: readonly string[] | undefined;
}

const PullSchema = z.looseObject({
	number: z.int(),
	html_url: z.string(),
	body: z.string().nullable().optional()
});

const HeadSchema = z.looseObject({ head: z.looseObject({ sha: z.string() }) });

// A deleted account comes back as null.
const UserSchema = z.looseObject({ login: z.string() }).nullable();

const ConversationCommentSchema = z.looseObject({
	id: z.int(),
	body: z.string().nullable(),
	user: UserSchema,
	created_at: z.string(),
	author_association: z.string().optional()
});

const LineCommentSchema = z.looseObject({
	...ConversationCommentSchema.shape,
	path: z.string(),
	// null once the line is gone from the head commit, and for a comment on a whole file
	line: z.int().nullable().optional(),
	subject_type: z.string().optional(),
	in_reply_to_id: z.int().nullable().optional(),
	pull_request_url: z.string().optional()
});

const ReviewSchema = z.looseObject({
	id: z.int(),
	body: z.string().nullable(),
	user: UserSchema,
	state: z.string(),
	submitted_at: z.string().nullable().optional(),
	author_association: z.string().optional()
});

const CheckRunSchema = z.looseObject({
	id: z.int(),
	name: z.string(),
	conclusion: z.string().nullable(),
	started_at: z.string().nullable().optional(),
	completed_at: z.string().nullable().optional(),
	app: z.looseObject({ slug: z.string() }).nullable().optional(),
	output: z
		.looseObject({
			title: z.string().nullable().optional(),
			summary: z.string().nullable().optional(),
			text: z.string().nullable().optional()
		})
		.nullable()
		.optional()
});

type CheckRun = z.infer<typeof CheckRunSchema>;

const CheckRunsSchema = z.looseObject({ check_runs: z.array(CheckRunSchema) });

// What a check ends in when it is feedback; a pass, a skip and a neutral one say nothing to answer.
const FAILED = ['failure', 'timed_out'];

// Checks that GitHub Actions ran are the repo's own workflows.
const ACTIONS = 'github-actions';

function checkBody(run: CheckRun): string {
	const output = [run.output?.title, run.output?.summary, run.output?.text]
		.filter((part): part is string => part !== null && part !== undefined && part.trim() !== '')
		.join('\n\n');
	return failedCheckBody(run.name, output);
}

interface Spoken {
	readonly body: string | null;
}

// Whether a comment or review has words of a person to answer: Nightjar's own and empty ones have none.
const hasWords = (raw: Spoken): boolean =>
	raw.body !== null && raw.body.trim() !== '' && !endsWithFooter(raw.body);

const FEEDBACK_ID = /^(comment|review|check):(\d+)$/;

const BodySchema = z.looseObject({ body: z.string().nullable() });

const ConversationBodySchema = z.looseObject({
	body: z.string().nullable(),
	issue_url: z.string().optional()
});

const gone = (feedbackId: string, n: string) =>
	new GitHubFailure(`GitHub has no ${feedbackId} on pull request #${n}.`);

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
	private readonly trust: GitHubTrust;
	private readonly trustedChecks: readonly string[];

	constructor(
		readonly repo: string,
		gh: GhRunner,
		private readonly git: GitRunner,
		options: GitHubCodeHostOptions = {}
	) {
		this.api = new GitHubApi(repo, gh);
		this.trust = new GitHubTrust(this.api, options.trusted);
		this.trustedChecks = (options.trustedChecks ?? []).map((slug) => slug.toLowerCase());
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

	async feedback(pull: Pull): Promise<Feedback[]> {
		const found = [
			...(await this.lineComments(pull)),
			...(await this.conversation(pull)),
			...(await this.reviews(pull)),
			...(await this.failedChecks(pull))
		];
		// stable, so what one moment shares stays in the order of the lists above
		return found.sort((a, b) => a.at.localeCompare(b.at));
	}

	private async lineComments(pull: Pull): Promise<Feedback[]> {
		const n = String(pull.id);
		const raw = await this.api.everyPage(
			`list the line comments on pull request #${n}`,
			`repos/${this.repo}/pulls/${n}/comments`,
			z.array(LineCommentSchema),
			(page) => page
		);
		const found: Feedback[] = [];
		for (const c of raw.filter(hasWords)) {
			// a comment on a whole file has no line and is no older version
			const gone = c.line == null && c.subject_type !== 'file';
			found.push({
				...(await this.said('comment', c.id, c, c.created_at)),
				path: c.path,
				...(c.line == null ? {} : { line: c.line }),
				...(gone ? { outdated: true as const } : {})
			});
		}
		return found;
	}

	private async conversation(pull: Pull): Promise<Feedback[]> {
		const n = String(pull.id);
		const raw = await this.api.everyPage(
			`list the comments on pull request #${n}`,
			`repos/${this.repo}/issues/${n}/comments`,
			z.array(ConversationCommentSchema),
			(page) => page
		);
		const found: Feedback[] = [];
		for (const c of raw.filter(hasWords)) {
			found.push(await this.said('comment', c.id, c, c.created_at));
		}
		return found;
	}

	private async reviews(pull: Pull): Promise<Feedback[]> {
		const n = String(pull.id);
		const raw = await this.api.everyPage(
			`list the reviews of pull request #${n}`,
			`repos/${this.repo}/pulls/${n}/reviews`,
			z.array(ReviewSchema),
			(page) => page
		);
		const found: Feedback[] = [];
		for (const r of raw.filter(hasWords)) {
			// a review still being written is seen by its author alone
			if (r.state === 'PENDING') continue;
			found.push(await this.said('review', r.id, r, r.submitted_at ?? ''));
		}
		return found;
	}

	private async said(
		kind: 'comment' | 'review',
		id: number,
		raw: z.infer<typeof ConversationCommentSchema> | z.infer<typeof ReviewSchema>,
		at: string
	): Promise<Feedback> {
		const author = raw.user?.login ?? '';
		return {
			id: `${kind}:${String(id)}`,
			kind,
			author,
			body: raw.body ?? '',
			at,
			trusted: author !== '' && (await this.trust.isTrusted(author, raw.author_association))
		};
	}

	private async failedChecks(pull: Pull): Promise<Feedback[]> {
		const n = String(pull.id);
		const head = await this.api.parse(
			`read pull request #${n}`,
			[`repos/${this.repo}/pulls/${n}`],
			HeadSchema
		);
		const runs = await this.api.everyPage(
			`list the check runs of pull request #${n}`,
			`repos/${this.repo}/commits/${head.head.sha}/check-runs`,
			CheckRunsSchema,
			(page) => page.check_runs
		);
		return runs
			.filter((run) => FAILED.includes(run.conclusion ?? ''))
			.map((run): Feedback => {
				const slug = (run.app?.slug ?? '').toLowerCase();
				return {
					id: `check:${String(run.id)}`,
					kind: 'check',
					author: slug,
					body: checkBody(run),
					at: run.completed_at ?? run.started_at ?? '',
					trusted: slug === ACTIONS || this.trustedChecks.includes(slug)
				};
			});
	}

	async reply(pull: Pull, feedbackId: string, body: string): Promise<void> {
		const n = String(pull.id);
		const named = FEEDBACK_ID.exec(feedbackId);
		if (named === null) throw new GitHubFailure(`${feedbackId} is no id of feedback.`);
		const [, kind, number = ''] = named;
		if (kind === 'comment') {
			const line = await this.api.find(
				`read comment ${number}`,
				[`repos/${this.repo}/pulls/comments/${number}`],
				LineCommentSchema
			);
			// a conversation comment may share a number with a line comment of another pull request
			if (line !== null && (line.pull_request_url ?? '').endsWith(`/pulls/${n}`)) {
				const thread = String(line.in_reply_to_id ?? line.id);
				await this.api.call(`reply to comment ${number}`, [
					'-X',
					'POST',
					`repos/${this.repo}/pulls/${n}/comments/${thread}/replies`,
					'-f',
					`body=${withFooter(body)}`
				]);
				return;
			}
		}
		await this.comment(pull, answerText(await this.answered(n, kind, number, feedbackId), body));
	}

	// the text a reply on the conversation quotes, as feedback() gives it
	private async answered(
		n: string,
		kind: string | undefined,
		number: string,
		feedbackId: string
	): Promise<string> {
		const what = `read ${feedbackId}`;
		if (kind === 'check') {
			const run = await this.api.find(
				what,
				[`repos/${this.repo}/check-runs/${number}`],
				CheckRunSchema
			);
			if (run === null) throw gone(feedbackId, n);
			return checkBody(run);
		}
		if (kind === 'review') {
			const review = await this.api.find(
				what,
				[`repos/${this.repo}/pulls/${n}/reviews/${number}`],
				BodySchema
			);
			if (review === null) throw gone(feedbackId, n);
			return review.body ?? '';
		}
		const said = await this.api.find(
			what,
			[`repos/${this.repo}/issues/comments/${number}`],
			ConversationBodySchema
		);
		// the comments endpoint is the whole repo's, so one of another pull request is found too
		if (said === null || !(said.issue_url ?? '').endsWith(`/issues/${n}`))
			throw gone(feedbackId, n);
		return said.body ?? '';
	}
}
