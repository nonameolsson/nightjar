// `nightjar init`: asks for the Tracker and Code host and what each needs, writes factory.json, makes
// the Tracker show the Signals, and checks every login. A repo that has a factory.json is not asked
// again: init only sets up and checks. The check command is always asked for, never guessed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { askOnStdin, type Ask } from './ask.js';
import type { AzureDevOpsRequest } from './azure-devops/index.js';
import { checkMachine, Refusal } from './checks.js';
import { CONFIG_FILE, ConfigError, ConfigSchema, loadConfig } from './config.js';
import { failures, printLines } from './doctor.js';
import { run, type Env } from './git.js';
import { repoFromRemote } from './github/api.js';
import { say, why } from './say.js';

export interface InitOptions {
	readonly root: string;
	readonly env: Env;
	readonly useApiKey: boolean;
	readonly ask: Ask;
	readonly request?: AzureDevOpsRequest;
}

// the published schema, so a repo that is no npm project gets editor completion too
const SCHEMA_URL = 'https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json';

const KINDS = ['github', 'azure-devops', 'module'] as const;
type Kind = (typeof KINDS)[number];

// The problem the real schema finds with `key` of a candidate that is otherwise valid, if any.
function problemWith(schema: z.ZodType, candidate: Record<string, unknown>, key: string) {
	const parsed = schema.safeParse(candidate);
	if (parsed.success) return null;
	return parsed.error.issues.find((i) => i.path[0] === key)?.message ?? null;
}

// Asks until the answer passes; an empty one takes the fallback, if there is one.
async function answer(
	ask: Ask,
	question: string,
	fallback: string | undefined,
	accept: (text: string) => string | null
): Promise<string> {
	for (;;) {
		const got = await ask(fallback === undefined ? `${question}: ` : `${question} [${fallback}]: `);
		if (got === null) throw new Refusal(`the input ended before this was answered: ${question}`);
		const text = got.trim() === '' ? (fallback ?? '') : got.trim();
		const problem = accept(text);
		if (problem === null) return text;
		console.log(`  ${problem}`);
	}
}

// The questions of one section, each checked by the schema's own rule for its field.
const probing = (ask: Ask, schema: z.ZodType, base: Record<string, unknown>) => ({
	field: (key: string, question: string, fallback?: string) =>
		answer(ask, question, fallback, (text) => problemWith(schema, { ...base, [key]: text }, key))
});

async function origin(root: string, env: Env): Promise<string | null> {
	const got = await run('git', ['remote', 'get-url', 'origin'], root, env);
	return got.ok ? repoFromRemote(got.out) : null;
}

const kindOf = (text: string): string | null =>
	(KINDS as readonly string[]).includes(text)
		? null
		: `choose ${KINDS.slice(0, -1).join(', ')} or ${KINDS.at(-1) ?? ''}`;

type Section = Record<string, unknown>;

// One of Tracker and Code host: its type, then what that type needs.
async function section(
	o: InitOptions,
	which: 'tracker' | 'codeHost',
	fromOrigin: string | null,
	guess: { kind: Kind; organization?: string; project?: string }
): Promise<{ section: Section; organization?: string; project?: string }> {
	const { ask } = o;
	const schema = ConfigSchema.shape[which];
	const label = which === 'tracker' ? 'Tracker' : 'Code host';
	const kind = (await answer(ask, `${label}: ${KINDS.join(', ')}`, guess.kind, kindOf)) as Kind;
	if (kind === 'github') {
		const ask1 = probing(ask, schema, { type: 'github' });
		const where = which === 'tracker' ? 'whose issues are the Features' : 'the branch is pushed to';
		const repo = await ask1.field(
			'repo',
			`GitHub repo ${where}, owner/name`,
			fromOrigin ?? undefined
		);
		// origin answers for a repo left out, so it is written only when it is another
		const writes = repo !== fromOrigin;
		return { section: { type: 'github', ...(writes ? { repo } : {}) } };
	}
	if (kind === 'module') {
		const interview = probing(ask, schema, { type: 'module' });
		const path = await interview.field(
			'path',
			`Module that builds the ${label}, as a path from the repo's root`
		);
		return { section: { type: 'module', path } };
	}
	const base = {
		type: 'azure-devops',
		organization: 'x',
		project: 'x',
		featureType: 'x',
		repo: 'x'
	};
	const interview = probing(ask, schema, base);
	const organization = await interview.field(
		'organization',
		'Azure DevOps organization, as in dev.azure.com/<organization>',
		guess.organization
	);
	const project = await interview.field(
		'project',
		`Project that holds the ${which === 'tracker' ? 'Features' : 'repo'}`,
		guess.project
	);
	if (which === 'codeHost') {
		const repo = await interview.field('repo', 'Git repo on Azure Repos, by name');
		return {
			section: { type: 'azure-devops', organization, project, repo },
			organization,
			project
		};
	}
	const featureType = await interview.field(
		'featureType',
		'Work item type that plays the Feature, such as Feature, Epic or Product Backlog Item',
		'Feature'
	);
	const ticket = await ask(
		'Work item type of a Ticket, for `nightjar create` (empty to leave out): '
	);
	if (ticket === null)
		throw new Refusal('the input ended before this was answered: the Ticket type');
	const ticketType = ticket.trim();
	return {
		section: {
			type: 'azure-devops',
			organization,
			project,
			featureType,
			...(ticketType ? { ticketType } : {})
		},
		organization,
		project
	};
}

async function interview(o: InitOptions): Promise<Record<string, unknown>> {
	const fromOrigin = await origin(o.root, o.env);
	const tracker = await section(o, 'tracker', fromOrigin, { kind: 'github' });
	const kind = tracker.section.type as Kind;
	const codeHost = await section(o, 'codeHost', fromOrigin, {
		kind: kind === 'module' ? 'github' : kind,
		...(tracker.organization === undefined ? {} : { organization: tracker.organization }),
		...(tracker.project === undefined ? {} : { project: tracker.project })
	});
	const check = await answer(
		o.ask,
		'Command that checks the work, run after each Ticket (no default)',
		undefined,
		(text) => (/\S/.test(text) ? null : 'name the command that checks the work')
	);
	const listed = await answer(
		o.ask,
		'Commands the agent may run, separated by commas, or none',
		check,
		() => null
	);
	const allowedCommands =
		listed === 'none'
			? []
			: listed
					.split(',')
					.map((c) => c.trim())
					.filter((c) => c !== '');
	return {
		$schema: SCHEMA_URL,
		tracker: tracker.section,
		codeHost: codeHost.section,
		check,
		allowedCommands
	};
}

function ignoresFactory(root: string): boolean {
	try {
		return readFileSync(join(root, '.gitignore'), 'utf8')
			.split('\n')
			.some((l) => /^\/?\.factory\/?$/.test(l.trim()));
	} catch {
		return false;
	}
}

export async function runInit(o: InitOptions): Promise<number> {
	const file = join(o.root, CONFIG_FILE);
	if (existsSync(file)) {
		loadConfig(o.root);
		say(`${CONFIG_FILE} is there already; keeping it`);
	} else {
		const config = await interview(o);
		const checked = ConfigSchema.safeParse(config);
		if (!checked.success) {
			throw new ConfigError(
				checked.error.issues
					.map((i) => `${CONFIG_FILE}: ${i.path.join('.')}: ${i.message}`)
					.join('\n')
			);
		}
		writeFileSync(file, `${JSON.stringify(config, null, '\t')}\n`);
		say(`wrote ${CONFIG_FILE}`);
	}
	if (!ignoresFactory(o.root))
		say('add `.factory/` to .gitignore: Nightjar keeps its status and logs there');

	const checked = await checkMachine({
		useApiKey: o.useApiKey,
		env: o.env,
		cwd: o.root,
		failFast: false,
		...(o.request === undefined ? {} : { request: o.request })
	});
	printLines(checked.lines);
	let problems = failures(checked.lines);
	if (checked.adapters !== null && checked.trackerOk) {
		try {
			for (const line of await checked.adapters.prepareSignals()) say(line);
		} catch (fault) {
			console.error(`  FAIL  Signals: ${why(fault)}`);
			problems += 1;
		}
	} else {
		say(
			'Signal labels not created: the Tracker could not be reached; fix that, then run `nightjar init` again.'
		);
	}
	if (problems > 0) {
		const count = problems === 1 ? '1 problem' : `${String(problems)} problems`;
		console.error(`nightjar: ${count} above; fix it, then run \`nightjar init\` again.`);
		return 2;
	}
	say('ready. Commit factory.json, give a Feature the Go, and run `nightjar doctor` any time.');
	return 0;
}

export interface InitHost {
	readonly env: Env;
	readonly cwd: string;
	readonly request?: AzureDevOpsRequest;
	readonly ask?: Ask;
}

// The `init` command: its arguments, the checkout it is run in, and a refusal said as it is.
export async function runInitCommand(argv: readonly string[], host: InitHost): Promise<number> {
	const unknown = argv.find((a) => a !== '--use-api-key');
	if (unknown !== undefined) {
		console.error(`nightjar: unknown argument ${unknown}\n\nusage: nightjar init [--use-api-key]`);
		return 2;
	}
	const env: Env = { ...host.env, GIT_TERMINAL_PROMPT: '0' };
	const asker = host.ask === undefined ? askOnStdin() : null;
	try {
		const top = await run('git', ['rev-parse', '--show-toplevel'], host.cwd, env);
		if (!top.ok) {
			console.error('nightjar: not inside a git checkout; run init at the root of the repo.');
			return 2;
		}
		return await runInit({
			root: top.out.trim(),
			env,
			useApiKey: argv.includes('--use-api-key'),
			ask: host.ask ?? asker?.ask ?? (() => Promise.resolve(null)),
			...(host.request === undefined ? {} : { request: host.request })
		});
	} catch (fault) {
		if (!(fault instanceof Refusal) && !(fault instanceof ConfigError)) throw fault;
		console.error(`nightjar: ${fault.message}`);
		return 2;
	} finally {
		asker?.close();
	}
}
