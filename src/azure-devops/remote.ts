// What a git remote on Azure Repos names, in each form Azure DevOps hands out to clone from.
export interface AzureRepo {
	readonly organization: string;
	readonly project: string;
	readonly repo: string;
}

// each form's organization, project and repo, in that order; the web address may carry a user name
const FORMS: readonly RegExp[] = [
	/^https:\/\/(?:[^/@\s]+@)?dev\.azure\.com\/([^/\s]+)\/([^/\s]+)\/_git\/([^/\s]+?)\/?$/i,
	/^git@ssh\.dev\.azure\.com:v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)\/?$/i,
	/^[^/@\s]+@vs-ssh\.visualstudio\.com:v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)\/?$/i,
	/^https:\/\/(?:[^/@\s]+@)?([^./@\s]+)\.visualstudio\.com\/([^/\s]+)\/_git\/([^/\s]+?)\/?$/i
];

// a name as a person reads it: an address spells a space as %20
function decoded(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

export function azureRepoFromRemote(url: string): AzureRepo | null {
	for (const form of FORMS) {
		const match = form.exec(url.trim());
		if (match === null) continue;
		const [organization = '', project = '', repo = ''] = match.slice(1).map(decoded);
		return { organization, project, repo };
	}
	return null;
}
