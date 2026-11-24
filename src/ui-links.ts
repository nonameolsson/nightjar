// Where the page sends a click: a Feature or Ticket on the Tracker, the pull requests on the Code host.
import { loadConfig } from './config.js';
import { repoFromRemote } from './github/api.js';
import { DEFAULT_SIGNAL_NAMES, type SignalNames } from './signals.js';

export interface Links {
	// "GitHub" or "Azure DevOps"; null for a Tracker the page cannot link to
	readonly tracker: string | null;
	// the Feature or Ticket on the Tracker; null for an id the Tracker has no page for
	readonly issue: (id: string) => string | null;
	readonly issues: string | null;
	// the open issues assigned to a person on the Tracker, where its address can say so; else all its issues; null with no Tracker page
	readonly assigned: (person: string) => string | null;
	readonly pulls: string | null;
	readonly signals: SignalNames;
}

export const NO_LINKS: Links = {
	tracker: null,
	issue: () => null,
	issues: null,
	assigned: () => null,
	pulls: null,
	signals: DEFAULT_SIGNAL_NAMES
};

const part = (text: string) => text.split('/').map(encodeURIComponent).join('/');
const azure = (organization: string, project: string) =>
	`https://dev.azure.com/${part(organization)}/${part(project)}`;

// Links from the repo's factory.json; `origin` names the GitHub repo when factory.json leaves it out. A repo that cannot be read gets none.
export function linksFor(root: string, origin: string | null): Links {
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig(root);
	} catch {
		return NO_LINKS;
	}
	const fromOrigin = origin === null ? null : repoFromRemote(origin);
	const { tracker, codeHost } = config;
	const numeric = (id: string) => /^\d+$/.test(id);

	let issue: Links['issue'] = () => null;
	let issues: string | null = null;
	let assigned: Links['assigned'] = () => null;
	let name: string | null = null;
	if (tracker.type === 'github') {
		const repo = tracker.repo ?? fromOrigin;
		if (repo !== null) {
			name = 'GitHub';
			issues = `https://github.com/${part(repo)}/issues`;
			issue = (id) => (numeric(id) ? `${issues ?? ''}/${id}` : null);
			assigned = (person) =>
				`${issues ?? ''}?q=${encodeURIComponent(`is:issue is:open assignee:${person}`)}`;
		}
	} else if (tracker.type === 'azure-devops') {
		name = 'Azure DevOps';
		const base = `${azure(tracker.organization, tracker.project)}/_workitems`;
		issues = base;
		issue = (id) => (numeric(id) ? `${base}/edit/${id}` : null);
		// its work item pages take no assignee in the address
		assigned = () => base;
	}

	let pulls: string | null = null;
	if (codeHost.type === 'github') {
		const repo = codeHost.repo ?? fromOrigin;
		if (repo !== null) pulls = `https://github.com/${part(repo)}/pulls`;
	} else if (codeHost.type === 'azure-devops')
		pulls = `${azure(codeHost.organization, codeHost.project)}/_git/${part(codeHost.repo)}/pullrequests`;

	return { tracker: name, issue, issues, assigned, pulls, signals: config.signals };
}
