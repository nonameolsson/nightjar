// factory.json: what a repo tells Nightjar about itself. It is validated here, and the published
// JSON Schema (schema/factory.schema.json) is generated from the same definition.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

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

const missingOr = (what: string) => (issue: { input: unknown }) =>
	issue.input === undefined ? `missing: ${what}` : undefined;

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

export type Config = Omit<z.infer<typeof ConfigSchema>, '$schema'>;

export function configJsonSchema(): object {
	return z.toJSONSchema(ConfigSchema, { io: 'input' });
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
