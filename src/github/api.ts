// Calls through the person's own `gh api`, which holds the login, so no token passes through here.
import { z } from 'zod';
import { firstLine, run, type Env, type Run } from '../git.js';

// A GitHub call Nightjar cannot do without; its message names the call and gh's reason.
export class GitHubFailure extends Error {}

export type GhRunner = (args: readonly string[]) => Promise<Run>;

export const ghRunner =
	(cwd: string, env: Env): GhRunner =>
	(args) =>
		run('gh', args, cwd, env);

export const IssueSchema = z.looseObject({
	// GitHub's own id, which the sub-issue and dependency calls take
	id: z.int().optional(),
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
	sub_issues_summary: z.looseObject({ total: z.int(), completed: z.int().optional() }).optional(),
	// the issues list also returns pull requests, which carry this
	pull_request: z.unknown().optional()
});

export type RawIssue = z.infer<typeof IssueSchema>;

// A Feature with more than 100 Tickets or comments is no Feature for one run.
const PAGE_SIZE = 100;

export const PAGE = `per_page=${String(PAGE_SIZE)}`;

// A list that long is no list a build can read.
const MAX_PAGES = 100;

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

	private json(what: string, got: Run): unknown {
		if (!got.ok) throw new GitHubFailure(`gh could not ${what}: ${firstLine(got.err)}`);
		if (got.out.trim() === '') return null;
		try {
			return JSON.parse(got.out) as unknown;
		} catch {
			throw new GitHubFailure(`gh printed no JSON when asked to ${what}.`);
		}
	}

	private shaped<T>(what: string, value: unknown, schema: z.ZodType<T>): T {
		const parsed = schema.safeParse(value);
		if (!parsed.success) throw new GitHubFailure(`GitHub answered ${what} in a shape not known.`);
		return parsed.data;
	}

	async call(what: string, args: readonly string[]): Promise<unknown> {
		return this.json(what, await this.raw(args));
	}

	async parse<T>(what: string, args: readonly string[], schema: z.ZodType<T>): Promise<T> {
		return this.shaped(what, await this.call(what, args), schema);
	}

	// null when GitHub has no such thing (404); any other refusal is a failure.
	async find<T>(what: string, args: readonly string[], schema: z.ZodType<T>): Promise<T | null> {
		const got = await this.raw(args);
		if (!got.ok && /HTTP 404/.test(got.err)) return null;
		return this.shaped(what, this.json(what, got), schema);
	}

	// Every page of a list, a hundred to a page; `items` takes a page's items out of what GitHub answers.
	async everyPage<P, T>(
		what: string,
		path: string,
		schema: z.ZodType<P>,
		items: (page: P) => readonly T[]
	): Promise<T[]> {
		const joined = path.includes('?') ? '&' : '?';
		const all: T[] = [];
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const got = items(
				await this.parse(what, [`${path}${joined}${PAGE}&page=${String(page)}`], schema)
			);
			all.push(...got);
			if (got.length < PAGE_SIZE) return all;
		}
		throw new GitHubFailure(`gh could not ${what}: more than ${String(MAX_PAGES)} pages.`);
	}
}

const GH_INSTALL = 'https://cli.github.com/';

// A failed call said with how to install gh or sign it in, whichever it may need.
export const ghFix = (message: string): string =>
	message.includes('is not on the PATH')
		? `${message} Install it from ${GH_INSTALL}, then run \`gh auth login\`.`
		: `${message} If gh is not signed in, run \`gh auth login\`.`;

// owner/name from an origin such as git@github.com:o/r.git or https://github.com/o/r
export function repoFromRemote(url: string): string | null {
	const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? `${match[1] ?? ''}/${match[2] ?? ''}` : null;
}
