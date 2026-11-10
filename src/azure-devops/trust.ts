// Whose words on Azure DevOps reach the Coding agent: one rule for the Tracker's comments and the Code host's feedback.
import { z } from 'zod';
import { AzureDevOpsFailure, type AzureDevOpsApi } from './api.js';

const API = 'api-version=7.1';

const ConnectionSchema = z.looseObject({
	authenticatedUser: z.looseObject({
		id: z.string(),
		properties: z.looseObject({ Account: z.looseObject({ $value: z.string().min(1) }) })
	})
});

export const IdentityRefSchema = z.looseObject({
	id: z.string().nullish(),
	uniqueName: z.string().nullish(),
	displayName: z.string().nullish()
});

export type IdentityRef = z.infer<typeof IdentityRefSchema>;

const IdentitiesSchema = z.looseObject({
	value: z.array(
		z
			.looseObject({
				id: z.string().nullish(),
				descriptor: z.string().nullish(),
				memberOf: z.array(z.string()).nullish()
			})
			.nullable()
	)
});

// Azure DevOps keeps names without regard to case.
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// One answer per key, read once and kept; a read that failed is forgotten, so the next asks again.
function kept<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
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

export class AzureTrust {
	private readonly signedIn = kept(() =>
		this.api
			.parse(
				'read the signed-in person',
				{ method: 'GET', url: this.api.at(`_apis/connectionData?${API}-preview`) },
				ConnectionSchema
			)
			.then((c) => ({
				name: c.authenticatedUser.properties.Account.$value,
				id: c.authenticatedUser.id
			}))
	);
	private readonly contributors = kept(() => this.contributorsGroup());
	private readonly members = kept((id) => this.isContributor(id));

	constructor(
		private readonly api: AzureDevOpsApi,
		// the project whose Contributors group is the default
		private readonly project: string,
		// factory.json's trusted list; when set it replaces the Contributors default
		private readonly trusted?: readonly string[]
	) {}

	// The person Azure DevOps is signed in as, which is Nightjar's own.
	me(): Promise<{ readonly name: string; readonly id: string }> {
		return this.signedIn('');
	}

	// Who `by` is, by the name `me()` gives for the signed-in person however Azure DevOps spells it, and whether they are trusted.
	async person(by: IdentityRef | null | undefined): Promise<{ name: string; trusted: boolean }> {
		const me = await this.me();
		const name = by?.id === me.id ? me.name : (by?.uniqueName ?? by?.displayName ?? '');
		return { name, trusted: await this.isTrusted(name, by?.id ?? null) };
	}

	// Whether an author is trusted: on the configured list, else in the project's Contributors group.
	private async isTrusted(author: string, id: string | null): Promise<boolean> {
		if (this.trusted !== undefined) return this.trusted.some((t) => same(t, author));
		return id === null ? false : this.members(id);
	}

	// On the configured list, else in the project's Contributors group; a person the organization does not know is not trusted.
	async trusts(person: string): Promise<boolean> {
		if (this.trusted !== undefined) return this.trusted.some((t) => same(t, person));
		const me = await this.me();
		const id = same(person, me.name) ? me.id : await this.identityOf(person);
		return id === null ? false : this.members(id);
	}

	// The identity id of the person with the sign-in name `person`; null when the organization has none.
	private async identityOf(person: string): Promise<string | null> {
		const got = await this.api.parse(
			`find ${person}`,
			{
				method: 'GET',
				url: this.api.identities(
					`_apis/identities?searchFilter=AccountName&filterValue=${encodeURIComponent(person)}&queryMembership=None&${API}`
				)
			},
			IdentitiesSchema
		);
		return got.value.find((i) => typeof i?.id === 'string')?.id ?? null;
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
