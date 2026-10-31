// factory.json: what a repo tells Nightjar about itself. It is validated here, and the published
// JSON Schema (schema/factory.schema.json) is generated from the same definition.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_SIGNAL_NAMES, RESERVED_NAMES, type SignalNames } from './signals.js';
import { why } from './say.js';

export class ConfigError extends Error {}

export const CONFIG_FILE = 'factory.json';

const repo = z
	.string()
	.regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name')
	.optional()
	.meta({ description: 'owner/name on GitHub; when left out, read from the origin remote' });

const GitHubTracker = z
	.strictObject({ type: z.literal('github'), repo })
	.meta({ description: 'GitHub Issues: a Feature is an issue with sub-issues, its Tickets' });

const missingOr = (what: string) => (issue: { input: unknown }) =>
	issue.input === undefined ? `missing: ${what}` : undefined;

const named = (what: string) => z.string({ error: missingOr(what) }).regex(/\S/, what);

const organization = named('name the organization')
	.regex(/^[^/\s:]+$/, 'the organization name alone, as in dev.azure.com/<organization>')
	.meta({ description: 'The organization, as in dev.azure.com/<organization>' });

const AzureDevOpsTracker = z
	.strictObject({
		type: z.literal('azure-devops'),
		organization,
		project: named('name the project').meta({ description: 'The project that holds the Features' }),
		featureType: named('name the work item type that plays the Feature').meta({
			description:
				'The work item type that plays the Feature, such as Feature, Epic or Product Backlog Item'
		}),
		ticketType: z
			.string()
			.regex(/\S/, 'name the work item type of a Ticket, or leave ticketType out')
			.optional()
			.meta({
				description:
					'The work item type nightjar create makes each Ticket as, such as User Story, Product Backlog Item or Issue. Left out, nightjar create makes no Tickets.'
			})
	})
	.meta({
		description:
			'Azure DevOps Boards: a Feature is a work item of featureType, its child work items its Tickets'
	});

const GitHubCodeHost = z
	.strictObject({ type: z.literal('github'), repo })
	.meta({ description: 'GitHub: the branch is pushed to origin and a draft pull request opened' });

const AzureReposCodeHost = z
	.strictObject({
		type: z.literal('azure-devops'),
		organization,
		project: named('name the project').meta({ description: 'The project that holds the repo' }),
		repo: named('name the repo').meta({ description: 'The Git repo on Azure Repos, by name' })
	})
	.meta({
		description:
			'Azure Repos: the branch is pushed to the repo and a draft pull request opened, signed in as for Azure DevOps Boards'
	});

// An Adapter the repo brings itself: a module (docs/custom-adapters.md) that builds the Tracker or Code host.
const adapterModule = (what: string) =>
	z
		.strictObject({
			type: z.literal('module'),
			path: z
				.string({ error: missingOr('name the module') })
				.regex(/\S/, 'name the module')
				.meta({
					description: `The module that builds the ${what}, as a path from the repo's root`
				}),
			options: z
				.record(z.string(), z.unknown())
				.optional()
				.meta({ description: 'Handed to the module as it is, for its own settings' })
		})
		.meta({ description: `A ${what} of the repo's own, built by a module` });

const modelField = z.string().regex(/\S/, 'a model is empty').optional();
const effortField = z.string().regex(/\S/, 'an effort is empty').optional();

const signalName = (fallback: string, what: string) =>
	z
		.string()
		.regex(/\S/, 'a Signal name is empty')
		.refine((name) => !(RESERVED_NAMES as readonly string[]).includes(name.trim().toLowerCase()), {
			error: 'this is a triage role; Nightjar never reads or sets it'
		})
		.default(fallback)
		.meta({ description: what });

const Signals = z
	.strictObject({
		go: signalName(
			DEFAULT_SIGNAL_NAMES.go,
			'The Go: put on a Feature assigned to you to have it built. Give it the name of ready to use one mark for both'
		),
		ready: signalName(DEFAULT_SIGNAL_NAMES.ready, 'A Ticket that is ready to be built'),
		working: signalName(DEFAULT_SIGNAL_NAMES.working, 'Nightjar is working on it'),
		needsInfo: signalName(DEFAULT_SIGNAL_NAMES.needsInfo, 'Nightjar needs an answer to go on'),
		human: signalName(DEFAULT_SIGNAL_NAMES.human, 'A person has to take it from here')
	})
	.prefault({})
	.meta({
		description:
			'The name each Signal has on a Tracker: a label on GitHub, a tag on Azure DevOps. Leave out the ones you do not rename. needs-triage and wontfix are refused.'
	});

export const ConfigSchema = z
	.strictObject({
		$schema: z.string().optional(),
		tracker: z
			.discriminatedUnion('type', [GitHubTracker, AzureDevOpsTracker, adapterModule('Tracker')], {
				error: missingOr('name the Tracker')
			})
			.meta({ description: 'Where the Features and Tickets live' }),
		codeHost: z
			.discriminatedUnion(
				'type',
				[GitHubCodeHost, AzureReposCodeHost, adapterModule('Code host')],
				{
					error: missingOr('name the Code host')
				}
			)
			.meta({ description: 'Where the branch is pushed and the draft pull request opened' }),
		check: z
			.string({ error: missingOr('name the command that checks the work') })
			.regex(/\S/, 'name the command that checks the work')
			.meta({
				description:
					'The shell command that checks the work in the worktree, run after each Ticket; it fails with a non-zero exit'
			}),
		allowedCommands: z
			.array(z.string().regex(/\S/, 'an allowed command is empty'), {
				error: missingOr('list the commands the agent may run')
			})
			.meta({
				description:
					'The commands the agent may run, as Claude Code Bash permission patterns without Bash( ), such as "make test" or "make lint *". Committing, pushing, switching branches, the network and gh stay denied.'
			}),
		rules: z.string().regex(/\S/, 'a rules file path is empty').optional().meta({
			description:
				'A text file, relative to the repo root, whose text is added to the agent prompt. Conventions normally live in CLAUDE.md or AGENTS.md.'
		}),
		model: modelField.meta({
			description:
				"The default model of every session; a Ticket's **Model:** line overrides it and --model overrides both"
		}),
		effort: effortField.meta({
			description:
				"The default effort of every session; a Ticket's **Effort:** line overrides it and --effort overrides both"
		}),
		review: z
			.strictObject({
				enabled: z
					.boolean()
					.optional()
					.meta({ description: 'false switches the review off; on by default' }),
				model: modelField.meta({
					description: "The review session's own model; else the default model"
				}),
				effort: effortField.meta({
					description: "The review session's own effort; else the default effort"
				})
			})
			.optional()
			.meta({
				description:
					'The read-only review of the whole diff, run before the draft pull request opens'
			}),
		signals: Signals,
		trusted: z.array(z.string().regex(/\S/, 'a trusted login is empty')).optional().meta({
			description:
				"The logins whose comments reach the agent (on Azure DevOps, sign-in names such as ann@contoso.com). When set, it replaces the Tracker default (GitHub: write access; Azure DevOps: the project's Contributors group); leave it out to keep the default."
		}),
		// worktree setup and reserved ports (N5)
		setup: z.string().regex(/\S/, 'name the setup command, or leave setup out').optional().meta({
			description:
				'The shell command run once in each new worktree, before the first session, such as one that installs dependencies. When it fails, the Feature stops with a comment saying why. Left out, nothing is run.'
		}),
		ports: z
			.strictObject({
				count: z.number().int().min(1).max(100).meta({ description: 'How many ports to reserve' }),
				env: z
					.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'not a valid variable name'), {
						error: missingOr('name the environment variables that carry the ports')
					})
					.min(1, 'name at least one environment variable')
					.refine((names) => new Set(names).size === names.length, 'a name is used twice')
					.meta({
						description:
							'The environment variables that carry the ports to every session, the check and the setup command: the first name gets the first reserved port, the next name the next port, and so on'
					})
			})
			.refine((p) => p.env.length <= p.count, {
				path: ['env'],
				error: 'more names than reserved ports'
			})
			.optional()
			.meta({
				description:
					'Ports reserved for each run and held for its whole life, so that two runs on one machine never share a port. Left out, no port is held.'
			})
	})
	.meta({ title: 'Nightjar factory.json' });

export type Config = Omit<z.infer<typeof ConfigSchema>, '$schema'> & {
	readonly signals: SignalNames;
};

export function configJsonSchema(): object {
	return z.toJSONSchema(ConfigSchema, { io: 'input' });
}

// The text of the rules file factory.json names, or null when it names none.
export function loadRules(root: string, config: Config): string | null {
	if (config.rules === undefined) return null;
	try {
		return readFileSync(join(root, config.rules), 'utf8').trim();
	} catch {
		throw new ConfigError(`${CONFIG_FILE}: rules: cannot read ${config.rules} in ${root}`);
	}
}

export const where = (path: readonly PropertyKey[]) =>
	path.length === 0 ? '' : `${path.map(String).join('.')}: `;

// The repo's factory.json, or a ConfigError naming each field that is wrong.
export function loadConfig(root: string): Config {
	let text: string;
	try {
		text = readFileSync(join(root, CONFIG_FILE), 'utf8');
	} catch {
		throw new ConfigError(`no ${CONFIG_FILE} in ${root}; run \`nightjar init\` to write one`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (fault) {
		throw new ConfigError(`${CONFIG_FILE} is not JSON: ${why(fault)}`);
	}
	const parsed = ConfigSchema.safeParse(value);
	if (!parsed.success) {
		const lines = parsed.error.issues.map((i) => `${CONFIG_FILE}: ${where(i.path)}${i.message}`);
		throw new ConfigError(lines.join('\n'));
	}
	const { $schema: _schema, ...config } = parsed.data;
	return config;
}
