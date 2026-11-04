// `nightjar init`: a repo with a factory.json is not asked again; else it asks, offering what the repo holds, and shows what it will write before it writes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { askOnStdin, type Ask } from './ask.js';
import type { AzureDevOpsRequest } from './azure-devops/index.js';
import { runCheck } from './check.js';
import { checkMachine, Refusal } from './checks.js';
import { CONFIG_FILE, ConfigError, ConfigSchema, loadConfig, type Config } from './config.js';
import { detectChecks, detectTools, type Detected } from './detect-check.js';
import { failures, printLines } from './doctor.js';
import { dryRun } from './queue.js';
import { run, type Env } from './git.js';
import { repoFromRemote, type GhRunner } from './github/api.js';
import { say, why } from './say.js';
import type { Os } from './sandbox.js';
import { clackPrompter, type Prompter } from './prompter.js';
import { DEFAULT_SIGNAL_NAMES, SIGNALS } from './signals.js';

// How each question is answered: by its flag, else by its default under --yes, else by asking.
interface Answering {
	readonly ask: Ask;
	// a terminal's select and multi-select prompts; without it every question is a line to ask
	readonly prompter?: Prompter;
	readonly yes: boolean;
	// each flag's value, by its name without the dashes, such as `check` or `tracker-repo`
	readonly flags: ReadonlyMap<string, string>;
}

export interface InitOptions extends Answering {
	readonly root: string;
	readonly env: Env;
	readonly os: Os;
	readonly useApiKey: boolean;
	readonly profile?: string;
	readonly request?: AzureDevOpsRequest;
	readonly gh?: GhRunner;
}

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
		if (fallback === undefined)
			throw new Refusal(`--yes found no default for: ${question}; pass --${flag}`);
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

async function origin(root: string, env: Env): Promise<string | null> {
	const got = await run('git', ['remote', 'get-url', 'origin'], root, env);
	return got.ok ? repoFromRemote(got.out) : null;
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

// One of Tracker and Code host: its type, then what that type needs.
async function section(
	o: InitOptions,
	which: 'tracker' | 'codeHost',
	fromOrigin: string | null,
	guess: { kind: Kind; organization?: string; project?: string }
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
			'The name of the repo in Azure Repos that the branch is pushed to.'
		);
		return {
			section: { type: 'azure-devops', organization, project, repo },
			organization,
			project
		};
	}
	const featureType = await interview.field(
		'featureType',
		'Work item type that plays the Feature, such as Feature, Epic or Product Backlog Item',
		'The work item type Nightjar reads as a Feature; its children are the Tickets.',
		'Feature'
	);
	const ticketType = await askTicketType(o);
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

// The check command: offered from what the repo holds, else asked for with a placeholder to go by.
async function askCheck(o: InitOptions): Promise<string> {
	const found = detectChecks(o.root);
	const question = 'Command that checks the work, run after each Ticket';
	const named = o.flags.has('check');
	if (found.length === 0 || named) {
		const hint = o.yes ? '' : '; try a placeholder such as `make check`';
		if (!named) say(`no check command detected in this repo${hint}`);
		return answer(o, 'check', question, undefined, checkProblem, CHECK_HELP);
	}
	if (found.length === 1) {
		const [only] = found;
		say(`detected \`${only?.command ?? ''}\` from ${only?.source ?? ''}`);
	} else if (o.yes) {
		say(`detected several check commands; taking the first, \`${found[0]?.command ?? ''}\``);
	} else if (o.prompter !== undefined) {
		return pickCheck(o.prompter, found, o, question);
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
		found[0]?.command,
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
	question: string
): Promise<string> {
	prompter.note(CHECK_HELP.short);
	const got = await prompter.select(
		question,
		[
			...found.map((d) => ({ value: d.command, label: d.command, hint: `from ${d.source}` })),
			{ value: OWN_CHECK, label: 'Type my own command' }
		],
		found[0]?.command
	);
	const picked = orCancel(got, question);
	if (picked !== OWN_CHECK) return picked;
	return answer(o, 'check', 'Command that checks the work', undefined, checkProblem, CHECK_HELP);
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

async function interview(o: InitOptions, fromOrigin: string | null): Promise<Answers> {
	const tracker = await section(o, 'tracker', fromOrigin, { kind: 'github' });
	const kind = tracker.section.type as Kind;
	const codeHost = await section(o, 'codeHost', fromOrigin, {
		kind: kind === 'module' ? 'github' : kind,
		...(tracker.organization === undefined ? {} : { organization: tracker.organization }),
		...(tracker.project === undefined ? {} : { project: tracker.project })
	});
	const check = await askCheck(o);
	warnIfNeverFails(check);
	const suggested = [...new Set([check, ...detectTools(o.root).map((d) => d.command)])];
	const allowedCommands = await askAllowed(o, suggested);
	const config = {
		$schema: SCHEMA_URL,
		tracker: tracker.section,
		codeHost: codeHost.section,
		check,
		allowedCommands
	};
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

// What init is about to do with the answers: the file it writes, the labels it creates, the logins it checks.
function printSummary(o: InitOptions, answers: Answers, fromOrigin: string | null): void {
	say('this is what init will do:');
	console.log(`  write ${CONFIG_FILE}:`);
	for (const line of JSON.stringify(answers.written, null, '\t').split('\n'))
		console.log(`    ${line}`);
	const { tracker, codeHost } = answers.parsed;
	if (tracker.type === 'github') {
		const names = SIGNALS.map((s) => DEFAULT_SIGNAL_NAMES[s]).join(', ');
		console.log(`  create the Signal labels on ${place(tracker, fromOrigin)}: ${names}`);
	} else if (tracker.type === 'azure-devops') {
		console.log('  create no Signal labels: Azure DevOps shows Signals as tags on first use');
	} else {
		console.log(`  create no Signal labels: ${tracker.path} shows Signals its own way`);
	}
	console.log('  check the logins:');
	console.log(`    ${LOGIN_TOOL[tracker.type]} for the Tracker, on ${place(tracker, fromOrigin)}`);
	console.log(
		`    ${LOGIN_TOOL[codeHost.type]} for the Code host, on ${place(codeHost, fromOrigin)}`
	);
	const profile = o.profile === undefined ? '' : ` under the profile ${o.profile}`;
	console.log(
		o.useApiKey
			? '    claude, billing ANTHROPIC_API_KEY'
			: `    claude, signed in to your Claude plan${profile}`
	);
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
			.some((l) => /^\/?\.factory\/?$/.test(l.trim()));
	} catch {
		return false;
	}
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

export async function runInit(o: InitOptions): Promise<number> {
	const file = join(o.root, CONFIG_FILE);
	const wrote = !existsSync(file);
	if (!wrote) {
		loadConfig(o.root);
		say(`${CONFIG_FILE} is there already; keeping it`);
	} else {
		const fromOrigin = await origin(o.root, o.env);
		const answers = await interview(o, fromOrigin);
		printSummary(o, answers, fromOrigin);
		if (!(await confirm(o))) {
			say(`wrote nothing; run \`nightjar init\` again to start over`);
			return 1;
		}
		writeFileSync(file, `${JSON.stringify(answers.written, null, '\t')}\n`);
		say(`wrote ${CONFIG_FILE}`);
		say(OPTIONAL_SETTINGS);
	}
	if (!ignoresFactory(o.root))
		say('add `.factory/` to .gitignore: Nightjar keeps its status and logs there');

	const checked = await checkMachine({
		os: o.os,
		useApiKey: o.useApiKey,
		...(o.profile === undefined ? {} : { profile: o.profile }),
		env: o.env,
		cwd: o.root,
		failFast: false,
		...(o.request === undefined ? {} : { request: o.request }),
		...(o.gh === undefined ? {} : { gh: o.gh })
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
	// a kept file's check was reported when it was written, and a re-run after a login fix needs none
	if (wrote) await reportCheck(o);
	if (problems > 0) {
		const count = problems === 1 ? '1 problem' : `${String(problems)} problems`;
		console.error(`nightjar: ${count} above; fix it, then run \`nightjar init\` again.`);
		return 2;
	}
	say(`ready. Commit ${CONFIG_FILE}, then:`);
	console.log('  1. run `nightjar doctor` to see what would build');
	console.log('  2. assign a Feature to yourself and give it the Go');
	// only a person who just answered the interview is asked; --yes and a kept file ask nothing
	if (!wrote || o.yes || checked.ready === null || !(await offerDoctor(o))) return 0;
	say('running `nightjar doctor`:');
	const { adapters, assignee } = checked.ready;
	try {
		await dryRun({ tracker: adapters.tracker, person: assignee, say });
	} catch (fault) {
		console.error(`  FAIL  Features: ${why(fault)}`);
		return 2;
	}
	return 0;
}

// Whether to run doctor now; an empty answer is yes, and an input that has ended is no.
async function offerDoctor(o: InitOptions): Promise<boolean> {
	if (o.prompter !== undefined) {
		o.prompter.note(
			'Doctor reads the Tracker and lists the Features it would build; it changes nothing.'
		);
		const question = 'Run `nightjar doctor` now?';
		const run = await o.prompter.confirm(question, true);
		if (run === null) say(`cancelled at: ${question}`);
		return run ?? false;
	}
	printHelp([
		'Doctor reads the Tracker and lists the Features it would build; it changes nothing.'
	]);
	for (;;) {
		const got = await o.ask('Run `nightjar doctor` now, y or n [y]: ');
		if (got === null) return false;
		const text = got.trim() === '' ? 'y' : got.trim();
		if (yesOrNo(text) === null) return /^y/i.test(text);
		console.log('  answer y or n');
	}
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

const INIT_USAGE = `usage: nightjar init [--yes] [--use-api-key] [--profile NAME] [--check CMD] [--allowed-commands LIST]
                     [--tracker TYPE] [--tracker-repo R] [--tracker-organization O] [--tracker-project P]
                     [--tracker-feature-type T] [--tracker-ticket-type T] [--tracker-path PATH]
                     [--code-host TYPE] [--code-host-repo R] [--code-host-organization O]
                     [--code-host-project P] [--code-host-path PATH]

  --yes, -y  take every default and ask nothing; a value with no default must be given by its flag
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
	readonly useApiKey: boolean;
	readonly flags: ReadonlyMap<string, string>;
}

// The arguments of `init`, or the line that says what is wrong with them.
function parseInitArgs(argv: readonly string[]): InitArgs | string {
	let yes = false;
	let useApiKey = false;
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i] ?? '';
		const name = a.replace(/^--/, '');
		if (a === '--yes' || a === '-y') yes = true;
		else if (a === '--use-api-key') useApiKey = true;
		else if (a.startsWith('--') && VALUE_FLAGS.has(name)) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) return `${a} needs a value`;
			flags.set(name, value);
			i += 1;
		} else return `unknown argument ${a}`;
	}
	return { yes, useApiKey, flags };
}

// The `init` command: its arguments, the checkout it is run in, and a refusal said as it is.
export async function runInitCommand(argv: readonly string[], host: InitHost): Promise<number> {
	const parsed = parseInitArgs(argv);
	if (typeof parsed === 'string') {
		console.error(`nightjar: ${parsed}\n\n${INIT_USAGE}`);
		return 2;
	}
	const { flags, yes } = parsed;
	const profile = flags.get('profile');
	const env: Env = { ...host.env, GIT_TERMINAL_PROMPT: '0' };
	// --yes asks nothing, so it leaves standard input alone
	const prompter =
		host.prompter ??
		(host.ask === undefined && !yes && process.stdin.isTTY && process.stdout.isTTY
			? clackPrompter()
			: undefined);
	const asker = host.ask === undefined && !yes && prompter === undefined ? askOnStdin() : null;
	try {
		const top = await run('git', ['rev-parse', '--show-toplevel'], host.cwd, env);
		if (!top.ok) {
			console.error('nightjar: not inside a git checkout; run init at the root of the repo.');
			return 2;
		}
		return await runInit({
			root: top.out.trim(),
			env,
			os: host.os,
			useApiKey: parsed.useApiKey,
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
