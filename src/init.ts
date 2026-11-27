// `nightjar init`: checks the machine first. A repo with a factory.json is not asked again; else it shows what it will write before it writes: on a terminal what it guessed, with one yes or no, and otherwise the answers it asked for. Under --dry-run it stops once that is shown.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { askOnStdin, type Ask } from './ask.js';
import {
	azureRepoFromRemote,
	openAzureDevOps,
	projectProcess,
	type AzureDevOpsRequest,
	type AzureRepo,
	type WorkItemTypes
} from './azure-devops/index.js';
import { runCheck } from './check.js';
import {
	checkLogins,
	checkMachine,
	checkPrerequisites,
	Refusal,
	type CheckOptions,
	type Line
} from './checks.js';
import { CONFIG_FILE, ConfigError, ConfigSchema, loadConfig, type Config } from './config.js';
import { detectChecks, detectTools, type Detected } from './detect-check.js';
import { failures, printLines } from './doctor.js';
import { run, type Env } from './git.js';
import { repoFromRemote, type GhRunner } from './github/api.js';
import { say, why } from './say.js';
import type { Os } from './sandbox.js';
import { clackPrompter, type Prompter } from './prompter.js';
import { recap } from './recap.js';
import { DEFAULT_SIGNAL_NAMES, SIGNALS } from './signals.js';

// How each question is answered: by its flag, else by its default under --yes, else by asking.
interface Answering {
	readonly ask: Ask;
	// a terminal's select and multi-select prompts; without it every question is a line to ask
	readonly prompter?: Prompter;
	readonly yes: boolean;
	// each flag's value, by its name without the dashes, such as `check` or `tracker-repo`
	readonly flags: ReadonlyMap<string, string>;
	// a dry run's: told of each value --yes would refuse at for want of a default, so the rest is still answered
	readonly missing?: (line: string) => void;
}

export interface InitOptions extends Answering {
	readonly root: string;
	readonly env: Env;
	readonly os: Os;
	readonly useApiKey: boolean;
	readonly dryRun: boolean;
	readonly profile?: string;
	readonly request?: AzureDevOpsRequest;
	readonly gh?: GhRunner;
	// what an Azure DevOps origin names, the default of each Azure DevOps question
	readonly azure?: AzureRepo;
	// set when that origin sets up Boards and Azure Repos: the Tracker project's types, null where its process names none
	readonly process?: { readonly types: WorkItemTypes | null };
}

// stands in a dry run for a value nothing gives; the schema takes it as an organization or project, which the Code host takes from the Tracker
const MISSING = '<missing>';

// the published schema, so a repo that is no npm project gets editor completion too
const SCHEMA_URL = 'https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json';

type Kind = Config['tracker']['type'];
// the Tracker kinds the schema takes, which the Code host takes too
const KINDS: readonly Kind[] = ConfigSchema.shape.tracker.options.map((o) => o.shape.type.value);

// The problem the real schema finds with `key` of a candidate that is otherwise valid, if any.
function problemWith(schema: z.ZodType, candidate: Record<string, unknown>, key: string) {
	const parsed = schema.safeParse(candidate);
	if (parsed.success) return null;
	return parsed.error.issues.find((i) => i.path[0] === key)?.message ?? null;
}

// What a prompt says about itself: a line or two before it asks, and longer help on `?`.
interface Help {
	readonly short: string;
	readonly long?: readonly string[];
}

const printHelp = (lines: readonly string[]) => {
	for (const line of lines) console.log(`  ${line}`);
};

// A flag answers as given; --yes takes the fallback, or refuses naming the flag; else it asks until the answer passes.
async function answer(
	o: Answering,
	flag: string,
	question: string,
	fallback: string | undefined,
	accept: (text: string) => string | null,
	help: Help
): Promise<string> {
	const given = o.flags.get(flag);
	if (given !== undefined) {
		const text = given.trim();
		const problem = accept(text);
		if (problem !== null) throw new Refusal(`--${flag} ${given}: ${problem}`);
		return text;
	}
	if (o.yes) {
		if (fallback === undefined) {
			const lacking = `--yes found no default for: ${question}; pass --${flag}`;
			if (o.missing === undefined) throw new Refusal(lacking);
			o.missing(lacking);
			return MISSING;
		}
		const problem = accept(fallback);
		if (problem !== null) throw new Refusal(`--yes: ${fallback} will not do: ${problem}`);
		return fallback;
	}
	const { ask, prompter } = o;
	const hint = help.long === undefined ? '' : ' (? for more)';
	if (prompter !== undefined) {
		prompter.note(help.short);
		// clack shows a refusal under the prompt, so `?` answers with the longer help there
		const got = await prompter.text(`${question}${hint}`, fallback, (t) =>
			t === '?' && help.long !== undefined ? help.long.join('\n') : accept(t)
		);
		const text = orCancel(got, question);
		return text === '' ? (fallback ?? '') : text;
	}
	printHelp(help.short.split('\n'));
	for (;;) {
		const got = await ask(
			fallback === undefined ? `${question}${hint}: ` : `${question}${hint} [${fallback}]: `
		);
		if (got === null) throw new Refusal(`the input ended before this was answered: ${question}`);
		if (got.trim() === '?') {
			printHelp(help.long ?? help.short.split('\n'));
			continue;
		}
		const text = got.trim() === '' ? (fallback ?? '') : got.trim();
		const problem = accept(text);
		if (problem === null) return text;
		console.log(`  ${problem}`);
	}
}

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// The questions of one section, each checked by the schema's own rule for its field; each field's flag is the section's, then the field's name in kebab case: `--code-host-repo`.
const probing = (
	o: Answering,
	prefix: string,
	schema: z.ZodType,
	base: Record<string, unknown>
) => ({
	field: (key: string, question: string, help: string, fallback?: string) =>
		answer(
			o,
			`${prefix}-${kebab(key)}`,
			question,
			fallback,
			(text) => problemWith(schema, { ...base, [key]: text }, key),
			{ short: help }
		)
});

async function originUrl(root: string, env: Env): Promise<string | null> {
	const got = await run('git', ['remote', 'get-url', 'origin'], root, env);
	return got.ok ? got.out : null;
}

const kindOf = (text: string): string | null =>
	(KINDS as readonly string[]).includes(text)
		? null
		: `choose ${KINDS.slice(0, -1).join(', ')} or ${KINDS.at(-1) ?? ''}`;

type Section = Record<string, unknown>;

// A cancelled prompt (null) ends init, naming the question it was cancelled at.
function orCancel<T>(got: T | null, at: string): T {
	if (got === null) throw new Refusal(`cancelled at: ${at}`);
	return got;
}

// The Tracker or Code host kind: picked from a list on a terminal, else asked as a line.
async function chooseKind(
	o: Answering,
	prefix: string,
	label: string,
	guess: Kind,
	help: string
): Promise<string> {
	const { prompter } = o;
	if (prompter === undefined || o.yes || o.flags.has(prefix))
		return answer(o, prefix, `${label}: ${KINDS.join(', ')}`, guess, kindOf, { short: help });
	prompter.note(help);
	const got = await prompter.select(
		label,
		KINDS.map((k) => ({ value: k, label: k })),
		guess
	);
	return orCancel(got, label);
}

// The type of a Ticket may be left out, so --yes leaves it out.
async function askTicketType(o: Answering): Promise<string> {
	const given = o.flags.get('tracker-ticket-type');
	if (given !== undefined) return given.trim();
	if (o.yes) return '';
	const help =
		'Only `nightjar create` needs this: the type it gives the Tickets it makes, such as User Story.';
	if (o.prompter !== undefined) {
		o.prompter.note(help);
		const got = await o.prompter.text(
			'Work item type of a Ticket, for `nightjar create` (empty to leave out)',
			undefined,
			() => null
		);
		return orCancel(got, 'the Ticket type');
	}
	printHelp([help]);
	const ticket = await o.ask(
		'Work item type of a Ticket, for `nightjar create` (empty to leave out): '
	);
	if (ticket === null)
		throw new Refusal('the input ended before this was answered: the Ticket type');
	return ticket.trim();
}

const FEATURE_TYPE_QUESTION =
	'Work item type that plays the Feature, such as Feature, Epic or Product Backlog Item';
const FEATURE_TYPE_HELP =
	'The work item type Nightjar reads as a Feature; its children are the Tickets.';

// The two types where an Azure DevOps origin sets up the pair: the process's as the defaults, and a Ticket's always written.
async function processTypes(o: Answering, read: WorkItemTypes | null): Promise<WorkItemTypes> {
	const lacking: string[] = [];
	// --yes names every type it lacks at once, not the first alone
	const asking =
		o.yes && o.missing === undefined
			? { ...o, missing: (line: string) => void lacking.push(line) }
			: o;
	const interview = probing(asking, 'tracker', ConfigSchema.shape.tracker, {
		type: 'azure-devops',
		organization: 'x',
		project: 'x'
	});
	const featureType = await interview.field(
		'featureType',
		FEATURE_TYPE_QUESTION,
		FEATURE_TYPE_HELP,
		// --yes takes no type the process does not name
		read?.featureType ?? (o.yes ? undefined : 'Feature')
	);
	const ticketType = await answer(
		asking,
		'tracker-ticket-type',
		'Work item type of a Ticket, for `nightjar create`',
		read?.ticketType,
		(text) => (/\S/.test(text) ? null : 'name the work item type of a Ticket, such as User Story'),
		{ short: 'The type `nightjar create` gives the Tickets it makes, such as User Story.' }
	);
	if (lacking.length > 0) throw new Refusal(lacking.join('\nnightjar: '));
	return { featureType, ticketType };
}

// What a section's questions offer: its kind, and what is known of where it is.
interface SectionGuess {
	readonly kind: Kind;
	readonly organization?: string;
	readonly project?: string;
	readonly repo?: string;
}

// One of Tracker and Code host: its type, then what that type needs.
async function section(
	o: InitOptions,
	which: 'tracker' | 'codeHost',
	fromOrigin: string | null,
	guess: SectionGuess
): Promise<{ section: Section; organization?: string; project?: string }> {
	const schema = ConfigSchema.shape[which];
	const label = which === 'tracker' ? 'Tracker' : 'Code host';
	const prefix = which === 'tracker' ? 'tracker' : 'code-host';
	const kindHelp =
		which === 'tracker'
			? 'The Tracker is where your Features and Tickets live (issues or work items).'
			: 'The Code host is where Nightjar pushes the branch and opens the draft pull request.';
	const kind = (await chooseKind(o, prefix, label, guess.kind, kindHelp)) as Kind;
	if (kind === 'github') {
		const ask1 = probing(o, prefix, schema, { type: 'github' });
		const where = which === 'tracker' ? 'whose issues are the Features' : 'the branch is pushed to';
		const repo = await ask1.field(
			'repo',
			`GitHub repo ${where}, owner/name`,
			'Written as owner/name, such as acme/widgets. Empty takes the repo of your git origin.',
			fromOrigin ?? undefined
		);
		// origin answers for a repo left out, so it is written only when it is another
		const writes = repo !== fromOrigin;
		return { section: { type: 'github', ...(writes ? { repo } : {}) } };
	}
	if (kind === 'module') {
		const interview = probing(o, prefix, schema, { type: 'module' });
		const path = await interview.field(
			'path',
			`Module that builds the ${label}, as a path from the repo's root`,
			`A JavaScript module in this repo that exports createTracker (or createCodeHost) for your own ${label}.`
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
	const interview = probing(o, prefix, schema, base);
	const organization = await interview.field(
		'organization',
		'Azure DevOps organization, as in dev.azure.com/<organization>',
		'The first part of your Azure DevOps address, after dev.azure.com/.',
		guess.organization
	);
	const project = await interview.field(
		'project',
		`Project that holds the ${which === 'tracker' ? 'Features' : 'repo'}`,
		`The Azure DevOps project that holds the ${which === 'tracker' ? 'work items' : 'git repo'}.`,
		guess.project
	);
	if (which === 'codeHost') {
		const repo = await interview.field(
			'repo',
			'Git repo on Azure Repos, by name',
			'The name of the repo in Azure Repos that the branch is pushed to.',
			guess.repo
		);
		return {
			section: { type: 'azure-devops', organization, project, repo },
			organization,
			project
		};
	}
	const types =
		o.process === undefined
			? {
					featureType: await interview.field(
						'featureType',
						FEATURE_TYPE_QUESTION,
						FEATURE_TYPE_HELP,
						'Feature'
					),
					ticketType: await askTicketType(o)
				}
			: await processTypes(o, o.process.types);
	const { featureType, ticketType } = types;
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

const CHECK_HELP: Help = {
	short:
		'Runs after every Ticket; a non-zero exit means the work failed and the Coding agent retries.',
	long: [
		'Runs after every Ticket. A non-zero exit means the work failed, and the Coding agent retries.',
		'Keep it fast and deterministic: typecheck, lint and tests.',
		'No deploys and no network: it runs many times, and must give the same answer each time.',
		'Examples: `npm run check`, `make check`.'
	]
};

const ALLOWED_HELP: Help = {
	short: [
		'The Coding agent may run only these, such as the test runner. Commit, push, network and `gh` stay denied, whatever is listed.',
		'A pattern ends in `*` to take any arguments. Examples: `make lint *`, `npm test`.'
	].join('\n'),
	long: [
		'The Coding agent may run only the commands listed here, separated by commas.',
		'List everything it needs: the test runner, the linter, and scripts it writes.',
		'Commit, push, network and `gh` are always denied, whatever is listed.',
		'A pattern ends in `*` to take any arguments. Examples: `make lint *`, `npm test`.',
		'Type none to allow no command.'
	]
};

// The check command: offered from what the repo holds, else asked for with a placeholder to go by. A `guess` taken before is offered over what is found.
async function askCheck(o: InitOptions, guess?: string): Promise<string> {
	const found = detectChecks(o.root);
	const question = 'Command that checks the work, run after each Ticket';
	const named = o.flags.has('check');
	if (found.length === 0 || named) {
		const hint = o.yes ? '' : '; try a placeholder such as `make check`';
		if (!named) say(`no check command detected in this repo${hint}`);
		return answer(o, 'check', question, guess, checkProblem, CHECK_HELP);
	}
	if (found.length === 1) {
		const [only] = found;
		say(`detected \`${only?.command ?? ''}\` from ${only?.source ?? ''}`);
	} else if (o.yes) {
		say(`detected several check commands; taking the first, \`${found[0]?.command ?? ''}\``);
	} else if (o.prompter !== undefined) {
		return pickCheck(o.prompter, found, o, question, guess ?? found[0]?.command);
	} else {
		say('detected several check commands; pick one number, or type your own command:');
		found.forEach((d, i) => {
			printHelp([`${String(i + 1)}. ${d.command}  (from ${d.source})`]);
		});
	}
	const text = await answer(
		o,
		'check',
		question,
		guess ?? found[0]?.command,
		(t) => {
			// A list such as `1,2` is not a command; the check is one command.
			if (/^[\d\s,]+$/.test(t) && !/^\d+$/.test(t))
				return `pick one number from 1 to ${String(found.length)}; the check is a single command`;
			if (/^\d+$/.test(t) && (Number(t) < 1 || Number(t) > found.length))
				return `pick one number from 1 to ${String(found.length)}, or type a command`;
			return checkProblem(t);
		},
		CHECK_HELP
	);
	return /^\d+$/.test(text) ? (found[Number(text) - 1]?.command ?? text) : text;
}

// The "Type my own command" pick; no command holds a NUL, so it never clashes with a detected one.
const OWN_CHECK = '\0own';

// Several checks detected: one is picked from a list, or the person types their own.
async function pickCheck(
	prompter: Prompter,
	found: readonly Detected[],
	o: Answering,
	question: string,
	initial: string | undefined
): Promise<string> {
	prompter.note(CHECK_HELP.short);
	// a command that was typed, not detected, is offered again where it was typed
	const own = found.some((d) => d.command === initial) ? undefined : initial;
	const got = await prompter.select(
		question,
		[
			...found.map((d) => ({ value: d.command, label: d.command, hint: `from ${d.source}` })),
			{ value: OWN_CHECK, label: 'Type my own command' }
		],
		own === undefined ? initial : OWN_CHECK
	);
	const picked = orCancel(got, question);
	if (picked !== OWN_CHECK) return picked;
	return answer(o, 'check', 'Command that checks the work', own, checkProblem, CHECK_HELP);
}

// A typed check command, or why it will not do; a list such as `1,2` is not one command.
function checkProblem(text: string): string | null {
	if (!/\S/.test(text)) return 'name the command that checks the work';
	if (/^[\d\s,]+$/.test(text) && !/^\d+$/.test(text))
		return 'the check is a single command, not a list of numbers';
	return null;
}

// `true` and `:` always exit zero; the warning is printed, and the command is still taken.
function warnIfNeverFails(command: string): void {
	if (command === 'true' || command === ':')
		say(`warning: \`${command}\` can never fail, so nothing will verify the work`);
}

// The answers as factory.json is written, and as the schema reads them.
interface Answers {
	readonly written: Record<string, unknown>;
	readonly parsed: Config;
}

const splitCommands = (listed: string) =>
	listed === 'none'
		? []
		: listed
				.split(',')
				.map((c) => c.trim())
				.filter((c) => c !== '');

// The commands the Coding agent may run: ticked from a list on a terminal, else one comma separated line.
async function askAllowed(o: Answering, suggested: readonly string[]): Promise<string[]> {
	const { prompter } = o;
	if (prompter === undefined || o.yes || o.flags.has('allowed-commands')) {
		const listed = await answer(
			o,
			'allowed-commands',
			'Commands the Coding agent may run, separated by commas, or none',
			suggested.join(', '),
			() => null,
			ALLOWED_HELP
		);
		return splitCommands(listed);
	}
	prompter.note(ALLOWED_HELP.short);
	const ticked =
		suggested.length === 0
			? []
			: await prompter.multiselect(
					'Commands the Coding agent may run',
					suggested.map((c) => ({ value: c, label: c })),
					suggested
				);
	const at = 'the commands the Coding agent may run';
	const picked = orCancel(ticked, at);
	const more = orCancel(
		await prompter.text('Others, separated by commas (empty for none)', '', () => null),
		at
	);
	return [...new Set([...picked, ...splitCommands(more)])];
}

// The Tracker, then the Code host. An Azure DevOps origin says where both are; else the Code host is guessed to be on the Tracker's own service.
async function askPair(o: InitOptions, fromOrigin: string | null) {
	const azure: SectionGuess | undefined =
		o.azure === undefined ? undefined : { kind: 'azure-devops', ...o.azure };
	const tracker = await section(o, 'tracker', fromOrigin, azure ?? { kind: 'github' });
	const kind = tracker.section.type as Kind;
	const codeHost = await section(
		o,
		'codeHost',
		fromOrigin,
		azure ?? {
			kind: kind === 'module' ? 'github' : kind,
			...(tracker.organization === undefined ? {} : { organization: tracker.organization }),
			...(tracker.project === undefined ? {} : { project: tracker.project })
		}
	);
	return { tracker: tracker.section, codeHost: codeHost.section };
}

// The pair init knows before it asks anything: what --yes would take from the flags and origin; null when only a question or a flag can tell.
async function knownPair(o: InitOptions, fromOrigin: string | null): Promise<Config | null> {
	try {
		const pair = await askPair({ ...o, yes: true }, fromOrigin);
		// the logins read the pair alone, so the check stands in for the one asked later
		const parsed = ConfigSchema.safeParse({ ...pair, check: 'true', allowedCommands: [] });
		return parsed.success ? parsed.data : null;
	} catch (fault) {
		// the interview refuses the same value again, after the machine is checked
		if (fault instanceof Refusal) return null;
		throw fault;
	}
}

// Where an Azure DevOps origin sets up Boards and Azure Repos, the options with the types the Tracker project's process names; else as they are.
async function readProcess(o: InitOptions, known: Config | null): Promise<InitOptions> {
	if (o.azure === undefined || known === null) return o;
	const { tracker, codeHost } = known;
	if (tracker.type !== 'azure-devops' || codeHost.type !== 'azure-devops') return o;
	// flags that name both types leave nothing to read
	if (o.flags.has('tracker-feature-type') && o.flags.has('tracker-ticket-type'))
		return { ...o, process: { types: null } };
	const { organization, project } = tracker;
	const where = `${organization}/${project}`;
	try {
		const api = openAzureDevOps(organization, o.root, o.env, undefined, o.request);
		const { name, types } = await projectProcess(api, project);
		if (types === null) {
			say(
				`the process of ${where}, ${name}, is not Agile, Scrum, Basic or CMMI and inherits from none, so its work item types cannot be guessed`
			);
		}
		return { ...o, process: { types } };
	} catch (fault) {
		say(`could not read the process of ${where}: ${why(fault)}`);
		return { ...o, process: { types: null } };
	}
}

// A process that names no types leaves its two questions, asked first; the answers are then guesses like the rest.
async function askUnguessedTypes(o: InitOptions): Promise<InitOptions> {
	if (o.process === undefined || o.process.types !== null) return o;
	return { ...o, process: { types: await processTypes(o, null) } };
}

// The commands offered to the Coding agent: the check, then the tools the repo's files name.
const suggestedCommands = (root: string, check: string) => [
	...new Set([check, ...detectTools(root).map((d) => d.command)])
];

type Pair = Awaited<ReturnType<typeof askPair>>;

// factory.json as the answers write it
const factoryJson = (pair: Pair, check: string, allowedCommands: readonly string[]) => ({
	$schema: SCHEMA_URL,
	...pair,
	check,
	allowedCommands
});

// The answers put together as factory.json, refused when the schema does not take them.
function answersFrom(pair: Pair, check: string, allowedCommands: readonly string[]): Answers {
	const config = factoryJson(pair, check, allowedCommands);
	const checked = ConfigSchema.safeParse(config);
	if (!checked.success) {
		throw new ConfigError(
			checked.error.issues
				.map((i) => `${CONFIG_FILE}: ${i.path.join('.')}: ${i.message}`)
				.join('\n')
		);
	}
	return { written: config, parsed: checked.data };
}

// Every question in turn: the pair, the check, then the commands the Coding agent may run.
async function askAll(o: InitOptions, fromOrigin: string | null, guessedCheck?: string) {
	const pair = await askPair(o, fromOrigin);
	const check = await askCheck(o, guessedCheck);
	warnIfNeverFails(check);
	const allowed = await askAllowed(o, suggestedCommands(o.root, check));
	return { pair, check, allowed };
}

async function interview(
	o: InitOptions,
	fromOrigin: string | null,
	guessedCheck?: string
): Promise<Answers> {
	const { pair, check, allowed } = await askAll(o, fromOrigin, guessedCheck);
	return answersFrom(pair, check, allowed);
}

// The setup taken from origin and the repo's files, asking for the check alone, and only when the repo names none or several.
async function guessAnswers(o: InitOptions, fromOrigin: string | null): Promise<Answers> {
	const pair = await askPair({ ...o, yes: true }, fromOrigin);
	const found = detectChecks(o.root);
	const only = found.length === 1 && !o.flags.has('check') ? found[0] : undefined;
	const check = only?.command ?? (await askCheck(o));
	warnIfNeverFails(check);
	const suggested = suggestedCommands(o.root, check);
	const allowed = o.flags.has('allowed-commands') ? await askAllowed(o, suggested) : suggested;
	return answersFrom(pair, check, allowed);
}

// Where a section of factory.json is: the repo on GitHub, the project on Azure DevOps, the path of a module.
function place(section: Config['tracker'] | Config['codeHost'], fromOrigin: string | null): string {
	if (section.type === 'github') return section.repo ?? fromOrigin ?? 'the repo of your git origin';
	if (section.type === 'module') return section.path;
	const repo = 'repo' in section ? `/${section.repo}` : '';
	return `${section.organization}/${section.project}${repo}`;
}

const LOGIN_TOOL: Record<Kind, string> = {
	github: 'GitHub CLI',
	'azure-devops': 'Azure CLI',
	module: 'the module'
};

type Chosen = Pick<Config, 'tracker' | 'codeHost'>;

// What a summary shows of a setup; one that lacks a value has not been through the schema, so it names no Signals.
type Shown = Chosen & Pick<Config, 'check' | 'allowedCommands'> & Partial<Pick<Config, 'signals'>>;

// What becomes of the Signal labels on the Tracker the answers chose.
function labelsLine({ tracker, signals }: Shown, fromOrigin: string | null): string {
	if (tracker.type === 'github') {
		const names = SIGNALS.map((s) => (signals ?? DEFAULT_SIGNAL_NAMES)[s]).join(', ');
		return `create the Signal labels on ${place(tracker, fromOrigin)}: ${names}`;
	}
	if (tracker.type === 'azure-devops')
		return 'create no Signal labels: Azure DevOps shows Signals as tags on first use';
	return `create no Signal labels: ${tracker.path} shows Signals its own way`;
}

function loginLines(o: InitOptions, config: Chosen, fromOrigin: string | null): string[] {
	const { tracker, codeHost } = config;
	const profile = o.profile === undefined ? '' : ` under the profile ${o.profile}`;
	return [
		`${LOGIN_TOOL[tracker.type]} for the Tracker, on ${place(tracker, fromOrigin)}`,
		`${LOGIN_TOOL[codeHost.type]} for the Code host, on ${place(codeHost, fromOrigin)}`,
		o.useApiKey
			? 'claude, billing ANTHROPIC_API_KEY'
			: `claude, signed in to your Claude plan${profile}`
	];
}

const SUMMARY_OPENING = 'this is what init will do:';

const jsonLines = (value: unknown) => JSON.stringify(value, null, '\t').split('\n');

// What init is about to do with the answers: the file it writes, the labels it creates, the logins it checks.
function printSummary(o: InitOptions, answers: Answers, fromOrigin: string | null): void {
	say(SUMMARY_OPENING);
	console.log(`  write ${CONFIG_FILE}:`);
	for (const line of jsonLines(answers.written)) console.log(`    ${line}`);
	console.log(`  ${labelsLine(answers.parsed, fromOrigin)}`);
	console.log('  check the logins:');
	for (const line of loginLines(o, answers.parsed, fromOrigin)) console.log(`    ${line}`);
}

const GITIGNORE_WRITE = '.gitignore, adding the line .factory/';

const serviceName = (
	section: Config['tracker'] | Config['codeHost'],
	github: string,
	azureDevOps: string
) =>
	section.type === 'github'
		? github
		: section.type === 'azure-devops'
			? azureDevOps
			: `the module ${section.path}`;

// The pair and where it is, as one line: `GitHub Issues + GitHub, repo o/app`. A module is named by its path alone.
function pairLine({ tracker, codeHost }: Chosen, fromOrigin: string | null): string {
	const issues = place(tracker, fromOrigin);
	const repo = place(codeHost, fromOrigin);
	// the repo's place says where the Tracker is too, when that is the same or holds it
	const covered =
		tracker.type === codeHost.type && (repo === issues || repo.startsWith(`${issues}/`));
	return [
		`${serviceName(tracker, 'GitHub Issues', 'Azure DevOps Boards')} + ${serviceName(codeHost, 'GitHub', 'Azure Repos')}`,
		...(tracker.type === 'module' || covered ? [] : [`Tracker on ${issues}`]),
		...(codeHost.type === 'module' ? [] : [`repo ${repo}`])
	].join(', ');
}

// How one summary differs from another: its first line, the lines of what it writes, and what it says of the logins.
interface Wording {
	readonly opening: string;
	// none leaves the writes out
	readonly writes: readonly string[];
	readonly logins: string;
}

// The summary a person at a terminal says yes or no to, which a dry run shows too.
function printTerminalSummary(
	o: InitOptions,
	shown: Shown,
	fromOrigin: string | null,
	{ opening, writes, logins }: Wording
): void {
	say(opening);
	console.log(`  ${pairLine(shown, fromOrigin)}`);
	console.log(`  check: ${shown.check}`);
	console.log(`  commands the Coding agent may run: ${shown.allowedCommands.join(', ') || 'none'}`);
	if (writes.length > 0) console.log('  write:');
	for (const line of writes) console.log(`    ${line}`);
	console.log(`  ${labelsLine(shown, fromOrigin)}`);
	console.log(`  ${logins}`);
	for (const line of loginLines(o, shown, fromOrigin)) console.log(`    ${line}`);
}

const yesOrNo = (text: string): string | null =>
	/^(y|yes|n|no)$/i.test(text) ? null : 'answer y or n';

// Whether to go on with what the summary shows; an empty answer is yes, and --yes asks nothing.
async function confirm(o: InitOptions): Promise<boolean> {
	const got = await answer(o, 'yes', `Write ${CONFIG_FILE} and go on, y or n`, 'y', yesOrNo, {
		short: `Any answer can be edited later in ${CONFIG_FILE}.`
	});
	return /^y/i.test(got);
}

function ignoresFactory(root: string): boolean {
	try {
		return readFileSync(join(root, '.gitignore'), 'utf8')
			.split('\n')
			.some((l) => /^(\/|\*\*\/)?\.factory(\/\*{0,2})?$/.test(l.trim()));
	} catch {
		return false;
	}
}

const ADD_FACTORY = 'add `.factory/` to .gitignore: Nightjar keeps its status and logs there';

function ignoreFactory(root: string): void {
	const file = join(root, '.gitignore');
	const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
	const gap = text === '' || text.endsWith('\n') ? '' : '\n';
	appendFileSync(file, `${gap}.factory/\n`);
}

// Runs the check once on the checkout as it is, and says whether it passes; it never fails init.
async function reportCheck(o: InitOptions): Promise<void> {
	const { check } = loadConfig(o.root);
	say(`running the check once on this checkout: ${check}`);
	const got = await runCheck(check, o.root, o.env);
	say(got.ok ? 'the check passes' : 'the check fails right now, so every Ticket will stop');
}

// The settings init leaves out, named once after it writes, with where the README explains them.
const README_CONFIG = 'https://github.com/nonameolsson/nightjar#configure-factoryjson';
const OPTIONAL_SETTINGS = `optional settings, left out by init: setup, ports, trusted, rules, model, review and workflows; see ${README_CONFIG}`;

const checkOptions = (o: InitOptions): Omit<CheckOptions, 'failFast'> => ({
	os: o.os,
	useApiKey: o.useApiKey,
	...(o.profile === undefined ? {} : { profile: o.profile }),
	env: o.env,
	cwd: o.root,
	...(o.request === undefined ? {} : { request: o.request }),
	...(o.gh === undefined ? {} : { gh: o.gh })
});

const problemCount = (count: number) => (count === 1 ? '1 problem' : `${String(count)} problems`);

// Lists each check that failed, with its fix; true when one did, and init is to write nothing.
function stopsAt(lines: readonly Line[]): boolean {
	const failed = lines.filter((l) => l.status === 'fail');
	if (failed.length === 0) return false;
	printLines(failed);
	console.error(
		`nightjar: ${problemCount(failed.length)} above, and nothing was written; fix it, then run \`nightjar init\` again.`
	);
	return true;
}

// The answers to write, or the exit code of a run that writes nothing.
type Settled = Answers | number;

function declined(): number {
	say(`wrote nothing; run \`nightjar init\` again to start over`);
	return 1;
}

// Piped answers and --yes: the interview, what init will do, and the go-ahead.
async function settleByAnswers(o: InitOptions, fromOrigin: string | null): Promise<Settled> {
	const answers = await interview(o, fromOrigin);
	if (stopsAt(await checkLogins(checkOptions(o), answers.parsed))) return 2;
	printSummary(o, answers, fromOrigin);
	return (await confirm(o)) ? answers : declined();
}

// A person at a terminal says yes or no to what was guessed from origin; on no, and where the pair is not the one origin's service gives, each question is asked first.
async function settleAtTerminal(
	given: InitOptions,
	prompter: Prompter,
	fromOrigin: string | null,
	known: Config | null
): Promise<Settled> {
	let o = given;
	const propose = async (answers: Answers, onNo: string) => {
		if (stopsAt(await checkLogins(checkOptions(o), answers.parsed))) return 2;
		printTerminalSummary(o, answers.parsed, fromOrigin, {
			opening: SUMMARY_OPENING,
			writes: [CONFIG_FILE, ...(ignoresFactory(o.root) ? [] : [GITIGNORE_WRITE])],
			logins: 'logins checked:'
		});
		prompter.note(`${onNo} Any answer can be edited later in ${CONFIG_FILE}.`);
		const question = 'Set up Nightjar like this?';
		return orCancel(await prompter.confirm(question, true), question) ? answers : 'no';
	};
	let guessedCheck: string | undefined;
	const onGitHub =
		fromOrigin !== null && known?.tracker.type === 'github' && known.codeHost.type === 'github';
	if (onGitHub || o.process !== undefined) {
		o = await askUnguessedTypes(o);
		const guessed = await guessAnswers(o, fromOrigin);
		const got = await propose(guessed, 'No asks each question, with these as the defaults.');
		if (got !== 'no') return got;
		guessedCheck = guessed.parsed.check;
	}
	const got = await propose(await interview(o, fromOrigin, guessedCheck), 'No writes nothing.');
	return got === 'no' ? declined() : got;
}

// What this run would do without --dry-run, each answer taken as --yes takes it: nothing is asked, written or created. `known` is the pair whose logins were checked.
async function showDryRun(
	o: InitOptions,
	fromOrigin: string | null,
	wrote: boolean,
	known: Config | null
): Promise<number> {
	// only a run at a terminal writes .gitignore
	const gitignore = wrote && !o.yes && o.prompter !== undefined && !ignoresFactory(o.root);
	const missing: string[] = [];
	let shown: Shown;
	let writes: string[] = [];
	if (wrote) {
		const asking = { ...o, yes: true, missing: (line: string) => void missing.push(line) };
		const { pair, check, allowed } = await askAll(asking, fromOrigin);
		const written = factoryJson(pair, check, allowed);
		// the schema judges a setup only once it lacks nothing
		shown =
			missing.length === 0
				? answersFrom(pair, check, allowed).parsed
				: ({ ...pair, check, allowedCommands: allowed } as Shown);
		writes = [
			`${CONFIG_FILE}:`,
			...jsonLines(written).map((line) => `  ${line}`),
			...(gitignore ? [GITIGNORE_WRITE] : [])
		];
	} else {
		say(`${CONFIG_FILE} is there already; init would keep it`);
		shown = loadConfig(o.root);
	}
	printTerminalSummary(o, shown, fromOrigin, {
		opening: 'dry run, so nothing is written or created; this is what init would do:',
		writes,
		logins:
			!wrote || known !== null
				? 'logins checked:'
				: 'logins (only claude is checked until the Tracker and Code host lack no value):'
	});
	if (!gitignore && !ignoresFactory(o.root)) say(ADD_FACTORY);
	for (const line of missing) say(line);
	if (missing.length > 0) say('`init --yes` would write nothing until each of these is given');
	return 0;
}

export async function runInit(given: InitOptions): Promise<number> {
	const file = join(given.root, CONFIG_FILE);
	const wrote = !existsSync(file);
	const url = await originUrl(given.root, given.env);
	const fromOrigin = url === null ? null : repoFromRemote(url);
	// piped answers come in the order asked, so an Azure DevOps origin changes no default of theirs
	const guesses = given.yes || given.dryRun || given.prompter !== undefined;
	const azure = guesses && url !== null ? azureRepoFromRemote(url) : null;
	const located = azure === null ? given : { ...given, azure };
	const known = wrote ? await knownPair(located, fromOrigin) : null;
	if (stopsAt(await checkPrerequisites(checkOptions(located), wrote ? known : CONFIG_FILE)))
		return 2;
	// read only now that the sign-in is checked
	const o = await readProcess(located, known);
	if (o.dryRun) return showDryRun(o, fromOrigin, wrote, known);
	// a person at a terminal, as against piped answers and --yes
	const terminal = o.yes ? undefined : o.prompter;
	if (!wrote) {
		say(`${CONFIG_FILE} is there already; keeping it`);
	} else {
		const settled =
			terminal === undefined
				? await settleByAnswers(o, fromOrigin)
				: await settleAtTerminal(o, terminal, fromOrigin, known);
		if (typeof settled === 'number') return settled;
		writeFileSync(file, `${JSON.stringify(settled.written, null, '\t')}\n`);
		say(`wrote ${CONFIG_FILE}`);
		if (terminal !== undefined && !ignoresFactory(o.root)) {
			ignoreFactory(o.root);
			say('added `.factory/` to .gitignore');
		}
		say(OPTIONAL_SETTINGS);
	}
	if (!ignoresFactory(o.root)) say(ADD_FACTORY);

	const checked = await checkMachine({ ...checkOptions(o), failFast: false });
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
	// a kept file's check was reported when it was written, and a re-run after a login fix needs none
	if (wrote) await reportCheck(o);
	if (problems > 0) {
		console.error(
			`nightjar: ${problemCount(problems)} above; fix it, then run \`nightjar init\` again.`
		);
		return 2;
	}
	// a terminal shows bold itself; elsewhere the output is read as Markdown, as Claude Code does
	const bold = (words: string) =>
		terminal === undefined ? `**${words}**` : `\x1b[1m${words}\x1b[22m`;
	console.log(recap({ go: loadConfig(o.root).signals.go, bold }));
	return 0;
}

export interface InitHost {
	readonly env: Env;
	readonly os: Os;
	readonly cwd: string;
	readonly request?: AzureDevOpsRequest;
	readonly gh?: GhRunner;
	readonly ask?: Ask;
	readonly prompter?: Prompter;
}

const INIT_USAGE = `usage: nightjar init [--yes] [--dry-run] [--no-tour] [--use-api-key] [--profile NAME]
                     [--check CMD] [--allowed-commands LIST]
                     [--tracker TYPE] [--tracker-repo R] [--tracker-organization O] [--tracker-project P]
                     [--tracker-feature-type T] [--tracker-ticket-type T] [--tracker-path PATH]
                     [--code-host TYPE] [--code-host-repo R] [--code-host-organization O]
                     [--code-host-project P] [--code-host-path PATH]

  --yes, -y  take every default and ask nothing; a value with no default must be given by its flag
  --dry-run  check the machine, show what init would write and create, taking each answer as --yes does,
             and name each value that lacks a flag; asks, writes and creates nothing
  --no-tour  stop once factory.json and .gitignore are written, with the recap of how to go on
  a flag sets its answer and skips its question; --allowed-commands is comma separated, or none`;

// the flags that take a value, each named as Answering.flags names it
const VALUE_FLAGS = new Set([
	'profile',
	'check',
	'allowed-commands',
	'tracker',
	'tracker-repo',
	'tracker-organization',
	'tracker-project',
	'tracker-feature-type',
	'tracker-ticket-type',
	'tracker-path',
	'code-host',
	'code-host-repo',
	'code-host-organization',
	'code-host-project',
	'code-host-path'
]);

interface InitArgs {
	readonly yes: boolean;
	readonly dryRun: boolean;
	readonly useApiKey: boolean;
	readonly flags: ReadonlyMap<string, string>;
}

// The arguments of `init`, or the line that says what is wrong with them.
function parseInitArgs(argv: readonly string[]): InitArgs | string {
	let yes = false;
	let dryRun = false;
	let useApiKey = false;
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i] ?? '';
		const name = a.replace(/^--/, '');
		if (a === '--yes' || a === '-y') yes = true;
		else if (a === '--dry-run') dryRun = true;
		else if (a === '--use-api-key') useApiKey = true;
		// every run ends once the files are written, which is all this flag asks for
		else if (a === '--no-tour') continue;
		else if (a.startsWith('--') && VALUE_FLAGS.has(name)) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) return `${a} needs a value`;
			flags.set(name, value);
			i += 1;
		} else return `unknown argument ${a}`;
	}
	return { yes, dryRun, useApiKey, flags };
}

// The `init` command: its arguments, the checkout it is run in, and a refusal said as it is.
export async function runInitCommand(argv: readonly string[], host: InitHost): Promise<number> {
	const parsed = parseInitArgs(argv);
	if (typeof parsed === 'string') {
		console.error(`nightjar: ${parsed}\n\n${INIT_USAGE}`);
		return 2;
	}
	const { flags, yes, dryRun } = parsed;
	const profile = flags.get('profile');
	const env: Env = { ...host.env, GIT_TERMINAL_PROMPT: '0' };
	// --yes asks nothing, so it leaves standard input alone
	const prompter =
		host.prompter ??
		(host.ask === undefined && !yes && process.stdin.isTTY && process.stdout.isTTY
			? clackPrompter()
			: undefined);
	const asks = !yes && !dryRun;
	const asker = host.ask === undefined && asks && prompter === undefined ? askOnStdin() : null;
	try {
		const top = await run('git', ['rev-parse', '--show-toplevel'], host.cwd, env);
		return await runInit({
			// outside a checkout the machine check refuses, and lists that with whatever else is missing
			root: top.ok ? top.out.trim() : host.cwd,
			env,
			os: host.os,
			useApiKey: parsed.useApiKey,
			dryRun,
			...(profile === undefined ? {} : { profile }),
			yes,
			flags,
			ask: host.ask ?? asker?.ask ?? (() => Promise.resolve(null)),
			...(prompter === undefined ? {} : { prompter }),
			...(host.request === undefined ? {} : { request: host.request }),
			...(host.gh === undefined ? {} : { gh: host.gh })
		});
	} catch (fault) {
		if (!(fault instanceof Refusal) && !(fault instanceof ConfigError)) throw fault;
		console.error(`nightjar: ${fault.message}`);
		return 2;
	} finally {
		asker?.close();
	}
}
