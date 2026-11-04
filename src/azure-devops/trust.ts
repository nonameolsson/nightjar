// Whose words on Azure DevOps reach the Coding agent: one rule for the Tracker's comments and the Code host's feedback.
import { z } from 'zod';
import { AzureDevOpsFailure, type AzureDevOpsApi } from './api.js';

const API = 'api-version=7.1';

const IdentitiesSchema = z.looseObject({
	value: z.array(
		z
			.looseObject({
				descriptor: z.string().nullish(),
				memberOf: z.array(z.string()).nullish()
			})
			.nullable()
	)
});

// Azure DevOps keeps names without regard to case.
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// One answer per key, read once and kept; a read that failed is forgotten, so the next asks again.
export function kept<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
	const known = new Map<string, Promise<T>>();
	return (key) => {
		let got = known.get(key);
		if (got === undefined) {
			got = read(key);
			known.set(key, got);
			got.catch(() => known.delete(key));
		}
		return got;
	};
}

export class AzureDevOpsTrust {
	private readonly contributors = kept(() => this.contributorsGroup());
	private readonly members = kept((id) => this.isContributor(id));

	constructor(
		private readonly api: AzureDevOpsApi,
		// the project whose Contributors group is the default
		private readonly project: string,
		// factory.json's trusted list; when set it replaces the Contributors default
		private readonly trusted?: readonly string[]
	) {}

	// Whether an author is trusted: on the configured list, else in the project's Contributors group.
	async isTrusted(author: string, id: string | null): Promise<boolean> {
		if (this.trusted !== undefined) return this.trusted.some((t) => same(t, author));
		return id === null ? false : this.members(id);
	}

	private async isContributor(id: string): Promise<boolean> {
		const group = await this.contributors('');
		const got = await this.api.parse(
			`read the groups of ${id}`,
			{
				method: 'GET',
				url: this.api.identities(
					`_apis/identities?identityIds=${encodeURIComponent(id)}&queryMembership=ExpandedUp&${API}`
				)
			},
			IdentitiesSchema
		);
		return (got.value[0]?.memberOf ?? []).some((d) => same(d, group));
	}

	// The descriptor of the project's Contributors group, which every member of the project's teams is in.
	private async contributorsGroup(): Promise<string> {
		const name = `[${this.project}]\\Contributors`;
		const got = await this.api.parse(
			`find the group ${name}`,
			{
				method: 'GET',
				url: this.api.identities(
					`_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(name)}&queryMembership=None&${API}`
				)
			},
			IdentitiesSchema
		);
		const descriptor = got.value[0]?.descriptor;
		if (!descriptor) throw new AzureDevOpsFailure(`Azure DevOps has no group ${name}.`);
		return descriptor;
	}
}
