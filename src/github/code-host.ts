// GitHub as a Code host: the branch goes to origin and each Ticket reference into the draft pull request.
import { z } from 'zod';
import type { CodeHost, DraftRequest, Pull } from '../code-host.js';
import { firstLine, type Run } from '../git.js';
import type { TicketReference } from '../tracker.js';
import { GitHubApi, GitHubFailure, type GhRunner } from './api.js';

export type GitRunner = (args: readonly string[], cwd: string) => Promise<Run>;

const PullSchema = z.looseObject({
	number: z.int(),
	html_url: z.string(),
	body: z.string().nullable().optional()
});

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
}
