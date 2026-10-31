// factory.json: what a repo tells Nightjar about itself. It is validated here, and the published
// JSON Schema (schema/factory.schema.json) is generated from the same definition.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_SIGNAL_NAMES, RESERVED_NAMES, type SignalNames } from './signals.js';

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

const GitHubCodeHost = z
	.strictObject({ type: z.literal('github'), repo })
	.meta({ description: 'GitHub: the branch is pushed to origin and a draft pull request opened' });

const modelField = z.string().regex(/\S/, 'a model is empty').optional();
const effortField = z.string().regex(/\S/, 'an effort is empty').optional();

const missingOr = (what: string) => (issue: { input: unknown }) =>
	issue.input === undefined ? `missing: ${what}` : undefined;

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
			'The name each Signal has on a Tracker: a label on GitHub. Leave out the ones you do not rename. needs-triage and wontfix are refused.'
	});

export const ConfigSchema = z
	.strictObject({
		$schema: z.string().optional(),
		tracker: z
			.discriminatedUnion('type', [GitHubTracker], { error: missingOr('name the Tracker') })
			.meta({ description: 'Where the Features and Tickets live' }),
		codeHost: z
			.discriminatedUnion('type', [GitHubCodeHost], { error: missingOr('name the Code host') })
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
				'The logins whose comments reach the agent. When set, it replaces the Tracker default (GitHub: write access); leave it out to keep the default.'
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

const where = (path: readonly PropertyKey[]) =>
	path.length === 0 ? '' : `${path.map(String).join('.')}: `;

// The repo's factory.json, or a ConfigError naming each field that is wrong.
export function loadConfig(root: string): Config {
	let text: string;
	try {
		text = readFileSync(join(root, CONFIG_FILE), 'utf8');
	} catch {
		throw new ConfigError(`no ${CONFIG_FILE} in ${root}; write one that names the check command`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (fault) {
		throw new ConfigError(
			`${CONFIG_FILE} is not JSON: ${fault instanceof Error ? fault.message : String(fault)}`
		);
	}
	const parsed = ConfigSchema.safeParse(value);
	if (!parsed.success) {
		const lines = parsed.error.issues.map((i) => `${CONFIG_FILE}: ${where(i.path)}${i.message}`);
		throw new ConfigError(lines.join('\n'));
	}
	const { $schema: _schema, ...config } = parsed.data;
	return config;
}
