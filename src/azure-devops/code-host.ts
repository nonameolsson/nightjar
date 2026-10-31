// Azure Repos as a Code host: the branch is pushed to the repo factory.json names, signed in as the
// Tracker is, and each Ticket is linked to the draft pull request as a work item when the Tracker is
// Azure DevOps Boards in the same organization, else named in its body. Nightjar never completes,
// abandons or publishes a pull request, and never sets a work item's state (docs/adr/0002).
import { z } from 'zod';
import type { CodeHost, DraftRequest, Pull } from '../code-host.js';
import { firstLine, type Env, type Run } from '../git.js';
import type { TicketReference } from '../tracker.js';
import { AzureDevOpsFailure, type AzureDevOpsApi } from './api.js';
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
}
