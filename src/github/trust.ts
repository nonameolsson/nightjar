// Whose words on GitHub reach the Coding agent: one rule for the Tracker's comments and the Code host's feedback.
import { z } from 'zod';
import { firstLine } from '../git.js';
import { GitHubFailure, type GitHubApi } from './api.js';

// Stand in for write access when the permission call is refused; a COLLABORATOR may hold only read.
const TIED = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const WRITE = ['admin', 'maintain', 'write'];

export class GitHubTrust {
	private readonly writers = new Map<string, boolean>();

	constructor(
		private readonly api: GitHubApi,
		// factory.json's trusted list; when set it replaces the write-access default
		private readonly trusted?: readonly string[]
	) {}

	// On the configured list, else may push; the comment's own association answers when a proxy refuses the permission call.
	async isTrusted(login: string, association?: string): Promise<boolean> {
		// GitHub logins are case-insensitive
		if (this.trusted !== undefined) {
			return this.trusted.some((t) => t.toLowerCase() === login.toLowerCase());
		}
		const known = this.writers.get(login);
		if (known !== undefined) return known;
		const got = await this.api.raw([
			`repos/${this.api.repo}/collaborators/${encodeURIComponent(login)}/permission`
		]);
		// 404 means no collaborator; reading any other refusal as no access would drop the person's own answers unsaid
		if (!got.ok && !/HTTP 404/.test(got.err)) {
			if (association !== undefined) return TIED.includes(association);
			throw new GitHubFailure(
				`gh could not read the permission of ${login}: ${firstLine(got.err)}`
			);
		}
		let value: unknown = null;
		try {
			value = got.ok ? JSON.parse(got.out) : null;
		} catch {
			// no JSON reads as no permission
		}
		const parsed = z.looseObject({ permission: z.string() }).safeParse(value);
		const can = parsed.success && WRITE.includes(parsed.data.permission);
		this.writers.set(login, can);
		return can;
	}
}
