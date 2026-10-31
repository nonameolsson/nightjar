// Builds the Tracker and Code host factory.json names, paired so each Ticket reference is one the Code host can place.
import { codeHostFromModule, trackerFromModule, type AdapterContext } from './adapter-module.js';
import {
	AzureBoardsTracker,
	AzureReposCodeHost,
	azRunner,
	azureDevOpsSignIn,
	fetchRequest,
	openAzureDevOps,
	type AzureDevOpsApi,
	type AzureDevOpsRequest,
	type AzureDevOpsSignIn,
	type ReferencesAs
} from './azure-devops/index.js';
import type { CodeHost } from './code-host.js';
import { CONFIG_FILE, ConfigError, type Config } from './config.js';
import { run, type Env } from './git.js';
import { GitHubApi, ghRunner, repoFromRemote, type GhRunner } from './github/api.js';
import { GitHubCodeHost } from './github/code-host.js';
import { createSignalLabels } from './github/labels.js';
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
	// makes the Tracker show the Signals (labels on GitHub), and says what it did
	readonly prepareSignals: () => Promise<readonly string[]>;
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
		standing: (id) => tracker.standing(id),
		tickets: (featureId) => tracker.tickets(featureId),
		comments: (id) => tracker.comments(id),
		addSignal: (id, signal) => tracker.addSignal(id, signal),
		removeSignal: (id, signal) => tracker.removeSignal(id, signal),
		comment: (id, body) => tracker.comment(id, body),
		reference: (id) => fit(tracker.reference(id))
	};
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// What building the adapters needs from this machine, shared by every kind.
interface Machine {
	readonly config: Config;
	readonly context: Omit<AdapterContext, 'options'>;
	readonly gh: GhRunner;
	readonly env: Env;
	readonly fromOrigin: (field: string) => Promise<string>;
	readonly azureDevOps: (organization: string) => AzureDevOpsApi;
}

interface TrackerBundle {
	readonly tracker: Tracker;
	readonly checked: (person: string) => string;
	readonly prepareSignals: () => Promise<readonly string[]>;
	// why this Tracker makes no Features though it may have the methods; null when it may
	readonly cannotCreate: string | null;
	// set for Azure DevOps Boards, whose work items Azure Repos of the same organization links
	readonly organization?: string;
	// the link to an item's page, for a Code host that cannot read the Tracker's own reference
	readonly page?: (id: string) => string;
}

type TrackerSpec<K extends TrackerKind> = Extract<Config['tracker'], { type: K }>;
type TrackerKind = Config['tracker']['type'];

const TRACKERS: {
	readonly [K in TrackerKind]: (spec: TrackerSpec<K>, m: Machine) => Promise<TrackerBundle>;
} = {
	module: async (spec, m) => {
		const tracker = await trackerFromModule(spec, m.context);
		return {
			tracker,
			checked: (person) => `${spec.path} as ${person}`,
			prepareSignals: () =>
				Promise.resolve([
					`${spec.path} shows Signals its own way: Nightjar creates nothing for it.`
				]),
			cannotCreate: canCreate(tracker)
				? null
				: `${CONFIG_FILE}: tracker: ${spec.path} makes no Features; its Tracker needs ${WRITER_LIST}`
		};
	},
	'azure-devops': (spec, m) => {
		const { organization, project } = spec;
		const api = m.azureDevOps(organization);
		const items = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_workitems/edit/`;
		return Promise.resolve({
			tracker: new AzureBoardsTracker(api, spec, m.config.signals, m.config.trusted),
			checked: (person) => `Azure DevOps as ${person} on ${organization}/${project}`,
			prepareSignals: () =>
				Promise.resolve([
					'Azure DevOps shows Signals as tags, which appear on first use: there is nothing to create.'
				]),
			cannotCreate:
				spec.ticketType === undefined
					? `${CONFIG_FILE}: tracker.ticketType: name the work item type each Ticket is made as, such as User Story`
					: null,
			organization,
			page: (id) => `[work item ${id}](${items}${id})`
		});
	},
	github: async (spec, m) => {
		const named = spec.repo ?? (await m.fromOrigin('tracker.repo'));
		return {
			tracker: new GitHubTracker(named, m.gh, m.config.signals, m.config.trusted),
			checked: (person) => `gh as ${person} on ${named}`,
			prepareSignals: () => createSignalLabels(m.gh, named, m.config.signals),
			cannotCreate: null,
			page: (id) => `[issue ${id}](https://github.com/${named}/issues/${id})`
		};
	}
};

type HostBundle = Pick<Adapters, 'codeHost' | 'repo' | 'reachCodeHost'> & {
	// what the preflight line adds after the Tracker
	readonly checkedTail: string;
	// how a Ticket's reference is rewritten for this Code host; null keeps the Tracker's own
	readonly fit: ((r: TicketReference) => TicketReference) | null;
};

type HostKind = Config['codeHost']['type'];
type HostSpec<K extends HostKind> = Extract<Config['codeHost'], { type: K }>;

const CODE_HOSTS: {
	readonly [K in HostKind]: (
		spec: HostSpec<K>,
		m: Machine,
		tracker: TrackerBundle
	) => Promise<HostBundle>;
} = {
	module: async (spec, m) => ({
		codeHost: await codeHostFromModule(spec, m.context),
		repo: spec.path,
		reachCodeHost: () => Promise.resolve(),
		checkedTail: '',
		fit: null
	}),
	github: async (spec, m) => {
		const repo = spec.repo ?? (await m.fromOrigin('codeHost.repo'));
		return {
			codeHost: new GitHubCodeHost(repo, m.gh, (args, cwd) => run('git', args, cwd, m.env)),
			repo,
			// the branch is pushed and the pull request opened as the person gh is signed in as
			reachCodeHost: async () => {
				await new GitHubApi(repo, m.gh).call('read the signed-in user', ['user']);
			},
			checkedTail: '',
			fit: null
		};
	},
	'azure-devops': (spec, m, t) => {
		const { organization, project, repo } = spec;
		const linked = t.organization !== undefined && sameName(t.organization, organization);
		const referencesAs: ReferencesAs = linked ? 'work items' : 'text';
		const codeHost = new AzureReposCodeHost(
			m.azureDevOps(organization),
			{ project, repo, referencesAs },
			(args, cwd, extra) => run('git', args, cwd, { ...m.env, ...extra })
		);
		// Azure Repos reads #N as a work item of its own organization, so any other Ticket is named by its page
		const page = t.page;
		const fit = linked
			? (r: TicketReference) => ({ ...r, text: `#${r.id}` })
			: page === undefined
				? null
				: (r: TicketReference) => ({ ...r, text: page(r.id) });
		return Promise.resolve({
			codeHost,
			repo: `${organization}/${project}/${repo}`,
			reachCodeHost: () => codeHost.check(),
			checkedTail: `, Azure Repos ${organization}/${project}/${repo}`,
			fit
		});
	}
};

// Calls the bundle maker of `spec`'s own kind; TypeScript cannot pair a union's member with its key.
const trackerFor = (spec: Config['tracker'], m: Machine) =>
	(TRACKERS[spec.type] as (s: Config['tracker'], m: Machine) => Promise<TrackerBundle>)(spec, m);

const codeHostFor = (spec: Config['codeHost'], m: Machine, t: TrackerBundle) =>
	(
		CODE_HOSTS[spec.type] as (
			s: Config['codeHost'],
			m: Machine,
			t: TrackerBundle
		) => Promise<HostBundle>
	)(spec, m, t);

// `request` answers every Azure DevOps call; a spec passes a fake Azure DevOps.
export async function makeAdapters(
	config: Config,
	root: string,
	env: Env,
	request: AzureDevOpsRequest = fetchRequest
): Promise<Adapters> {
	let origin: string | null | undefined;
	// one sign-in for every Azure DevOps Adapter, made when the first needs it
	let signIn: AzureDevOpsSignIn | undefined;
	const machine: Machine = {
		config,
		env,
		gh: ghRunner(root, env),
		context: {
			root,
			signals: config.signals,
			...(config.trusted === undefined ? {} : { trusted: config.trusted })
		},
		fromOrigin: async (field) => {
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
		},
		azureDevOps: (organization) => {
			signIn ??= azureDevOpsSignIn(azRunner(root, env), env);
			return openAzureDevOps(organization, root, env, signIn, request);
		}
	};

	const t = await trackerFor(config.tracker, machine);
	// taken before any wrapping for the Code host, which keeps only the Tracker's own methods
	const writer =
		t.cannotCreate === null && canCreate(t.tracker)
			? t.tracker
			: (t.cannotCreate ?? `${CONFIG_FILE}: tracker: this Tracker makes no Features`);
	const host = await codeHostFor(config.codeHost, machine, t);
	return {
		tracker: host.fit === null ? t.tracker : referencing(t.tracker, host.fit),
		codeHost: host.codeHost,
		repo: host.repo,
		checked: (person) => `${t.checked(person)}${host.checkedTail}`,
		reachCodeHost: host.reachCodeHost,
		prepareSignals: t.prepareSignals,
		writer
	};
}
