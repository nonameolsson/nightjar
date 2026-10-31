// The Tracker and Code host factory.json names, built over this machine's gh, git and Azure DevOps
// sign-in, and paired so each Ticket reference is one the Code host can place.
import { codeHostFromModule, trackerFromModule } from './adapter-module.js';
import {
	AzureBoardsTracker,
	AzureReposCodeHost,
	azRunner,
	azureDevOpsSignIn,
	fetchRequest,
	openAzureDevOps,
	type AzureDevOpsRequest,
	type AzureDevOpsSignIn,
	type ReferencesAs
} from './azure-devops/index.js';
import type { CodeHost } from './code-host.js';
import { CONFIG_FILE, ConfigError, type Config } from './config.js';
import { run, type Env } from './git.js';
import { ghRunner, repoFromRemote } from './github/api.js';
import { GitHubCodeHost } from './github/code-host.js';
import { GitHubTracker } from './github/tracker.js';
import {
	canCreate,
	FEATURE_WRITER_METHODS,
	type FeatureWriter,
	type TicketReference,
	type Tracker
} from './tracker.js';

export interface Adapters {
	readonly tracker: Tracker;
	readonly codeHost: CodeHost;
	// what the ledger names the repo by
	readonly repo: string;
	// how the preflight line names the Tracker it reached, as `person`, and the Code host
	readonly checked: (person: string) => string;
	// reaches the Code host, so a run that cannot push stops before it builds anything
	readonly reachCodeHost: () => Promise<void>;
	// the Tracker as one that makes Features and Tickets, or why it cannot
	readonly writer: (Tracker & FeatureWriter) | string;
}

const WRITER_LIST = `${FEATURE_WRITER_METHODS.slice(0, -1).join(', ')} and ${FEATURE_WRITER_METHODS.at(-1) ?? ''}`;

// The Tracker with its references rewritten for the Code host; every other call goes to it as it is.
function referencing(tracker: Tracker, fit: (r: TicketReference) => TicketReference): Tracker {
	return {
		me: () => tracker.me(),
		assignedFeatures: (person) => tracker.assignedFeatures(person),
		feature: (id) => tracker.feature(id),
		tickets: (featureId) => tracker.tickets(featureId),
		comments: (id) => tracker.comments(id),
		addSignal: (id, signal) => tracker.addSignal(id, signal),
		removeSignal: (id, signal) => tracker.removeSignal(id, signal),
		comment: (id, body) => tracker.comment(id, body),
		reference: (id) => fit(tracker.reference(id))
	};
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// `request` answers every Azure DevOps call; a spec passes a fake Azure DevOps.
export async function makeAdapters(
	config: Config,
	root: string,
	env: Env,
	request: AzureDevOpsRequest = fetchRequest
): Promise<Adapters> {
	let origin: string | null | undefined;
	const fromOrigin = async (field: string) => {
		if (origin === undefined) {
			const got = await run('git', ['remote', 'get-url', 'origin'], root, env);
			origin = got.ok ? repoFromRemote(got.out) : null;
		}
		if (origin === null) {
			throw new ConfigError(
				`origin is not a GitHub repo; set ${field} to owner/name in factory.json`
			);
		}
		return origin;
	};
	const gh = ghRunner(root, env);
	const git = (args: readonly string[], cwd: string) => run('git', args, cwd, env);
	// one sign-in for every Azure DevOps Adapter, made when the first needs it
	let signIn: AzureDevOpsSignIn | undefined;
	const azureDevOps = (organization: string) => {
		signIn ??= azureDevOpsSignIn(azRunner(root, env), env);
		return openAzureDevOps(organization, root, env, signIn, request);
	};

	const context = {
		root,
		signals: config.signals,
		...(config.trusted === undefined ? {} : { trusted: config.trusted })
	};
	let tracker: Tracker;
	let checked: (person: string) => string;
	let trackerRepo: string | null = null;
	let cannotCreate: string | null = null;
	if (config.tracker.type === 'module') {
		const { path } = config.tracker;
		tracker = await trackerFromModule(config.tracker, context);
		checked = (person) => `${path} as ${person}`;
		if (!canCreate(tracker)) {
			cannotCreate = `${CONFIG_FILE}: tracker: ${path} makes no Features; its Tracker needs ${WRITER_LIST}`;
		}
	} else if (config.tracker.type === 'azure-devops') {
		const { organization, project } = config.tracker;
		const api = azureDevOps(organization);
		tracker = new AzureBoardsTracker(api, config.tracker, config.signals, config.trusted);
		checked = (person) => `Azure DevOps as ${person} on ${organization}/${project}`;
		if (config.tracker.ticketType === undefined) {
			cannotCreate = `${CONFIG_FILE}: tracker.ticketType: name the work item type each Ticket is made as, such as User Story`;
		}
	} else {
		const named = config.tracker.repo ?? (await fromOrigin('tracker.repo'));
		trackerRepo = named;
		tracker = new GitHubTracker(named, gh, config.signals, config.trusted);
		checked = (person) => `gh as ${person} on ${named}`;
	}
	// taken before any wrapping for the Code host, which keeps only the Tracker's own methods
	const writer =
		cannotCreate === null && canCreate(tracker)
			? tracker
			: (cannotCreate ?? `${CONFIG_FILE}: tracker: this Tracker makes no Features`);

	if (config.codeHost.type === 'module') {
		const codeHost = await codeHostFromModule(config.codeHost, context);
		return {
			tracker,
			codeHost,
			repo: config.codeHost.path,
			checked,
			reachCodeHost: () => Promise.resolve(),
			writer
		};
	}
	if (config.codeHost.type === 'github') {
		const repo = config.codeHost.repo ?? (await fromOrigin('codeHost.repo'));
		const codeHost = new GitHubCodeHost(repo, gh, git);
		return { tracker, codeHost, repo, checked, reachCodeHost: () => Promise.resolve(), writer };
	}

	const { organization, project, repo } = config.codeHost;
	const t = config.tracker;
	const linked = t.type === 'azure-devops' && sameName(t.organization, organization);
	const referencesAs: ReferencesAs = linked ? 'work items' : 'text';
	const codeHost = new AzureReposCodeHost(
		azureDevOps(organization),
		{ project, repo, referencesAs },
		(args, cwd, extra) => run('git', args, cwd, { ...env, ...extra })
	);
	// Azure Repos reads #N as a work item of its own organization, so any other Ticket is named by its page
	let fit: ((r: TicketReference) => TicketReference) | null = null;
	if (linked) {
		fit = (r) => ({ ...r, text: `#${String(r.id)}` });
	} else if (t.type === 'azure-devops') {
		const page = `https://dev.azure.com/${encodeURIComponent(t.organization)}/${encodeURIComponent(t.project)}/_workitems/edit/`;
		fit = (r) => ({ ...r, text: `[work item ${String(r.id)}](${page}${String(r.id)})` });
	} else if (trackerRepo !== null) {
		const page = `https://github.com/${trackerRepo}/issues/`;
		fit = (r) => ({ ...r, text: `[issue ${String(r.id)}](${page}${String(r.id)})` });
	}
	return {
		tracker: fit === null ? tracker : referencing(tracker, fit),
		codeHost,
		repo: `${organization}/${project}/${repo}`,
		checked: (person) => `${checked(person)}, Azure Repos ${organization}/${project}/${repo}`,
		reachCodeHost: () => codeHost.check(),
		writer
	};
}
