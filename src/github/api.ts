// The REST calls the GitHub adapters make through the person's own `gh api`, and the schemas of
// what they answer. `gh` holds the login, so no token passes through here. Only the GitHub
// adapters call `gh`.
import { z } from 'zod';
import { firstLine, type Run } from '../git.js';

// A GitHub call Nightjar cannot do without; its message names the call and gh's reason.
export class GitHubFailure extends Error {}

export type GhRunner = (args: readonly string[]) => Promise<Run>;

export const IssueSchema = z.looseObject({
	number: z.int(),
	title: z.string(),
	body: z.string().nullable(),
	state: z.string(),
	labels: z.array(z.looseObject({ name: z.string() })),
	assignees: z
		.array(z.looseObject({ login: z.string() }))
		.nullable()
		.optional(),
	user: z.looseObject({ login: z.string() }).nullable(),
	sub_issues_summary: z.looseObject({ total: z.int() }).optional(),
	// the issues list also returns pull requests, which carry this
	pull_request: z.unknown().optional()
});

export type RawIssue = z.infer<typeof IssueSchema>;

// One page of 100 is all Nightjar reads: a Feature with more Tickets or comments is no Feature for
// one run.
export const PAGE = 'per_page=100';

export class GitHubApi {
	constructor(
		readonly repo: string,
		private readonly gh: GhRunner
	) {}

	// gh's own answer, for a caller that reads a refusal itself.
	async raw(args: readonly string[]): Promise<Run> {
		const got = await this.gh(['api', ...args]);
		if (got.missing) throw new GitHubFailure('gh is not on the PATH.');
		return got;
	}

	async call(what: string, args: readonly string[]): Promise<unknown> {
		const got = await this.raw(args);
		if (!got.ok) throw new GitHubFailure(`gh could not ${what}: ${firstLine(got.err)}`);
		if (got.out.trim() === '') return null;
		try {
			return JSON.parse(got.out) as unknown;
		} catch {
			throw new GitHubFailure(`gh printed no JSON when asked to ${what}.`);
		}
	}

	async parse<T>(what: string, args: readonly string[], schema: z.ZodType<T>): Promise<T> {
		const parsed = schema.safeParse(await this.call(what, args));
		if (!parsed.success) throw new GitHubFailure(`GitHub answered ${what} in a shape not known.`);
		return parsed.data;
	}
}

// owner/name from an origin such as git@github.com:o/r.git or https://github.com/o/r
export function repoFromRemote(url: string): string | null {
	const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? `${match[1] ?? ''}/${match[2] ?? ''}` : null;
}
