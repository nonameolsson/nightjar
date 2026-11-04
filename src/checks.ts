// `doctor` and `init` run every check and list each; a build stops at the first that fails. Each failure says how to fix it.
import { join } from 'node:path';
import { makeAdapters, type Adapters } from './adapters.js';
import { accountLine, parseAccount, profileEnv } from './account.js';
import { apiKeyProblem } from './args.js';
import type { AzureDevOpsRequest } from './azure-devops/index.js';
import { checksOver, runChecks, type Check, type Line } from './check-runner.js';
import { loadConfig, loadRules, type Config } from './config.js';
import { installCommand } from './install-commands.js';
import { localTime, nextDue, parseCron } from './cron.js';
import type { GhRunner } from './github/api.js';
import { loadPersonConfig, type PersonConfig } from './person-config.js';
import { firstLine, run, type Env } from './git.js';
import { goFault } from './intake.js';
import { isLoaded, loadedSkills, type LoadedSkills } from './skills.js';
import { templateFaults } from './template.js';
import { readKernel, sandboxFinding } from './sandbox.js';
import { skillsNamed } from './workflow.js';
import { defaultBranch, signing } from './worktree.js';
import { why } from './say.js';

export type { Line } from './check-runner.js';

// A reason Nightjar will not start on this machine, said as it is.
export class Refusal extends Error {}

export interface Ready {
	readonly root: string;
	readonly config: Config;
	readonly adapters: Adapters;
	readonly me: string;
	readonly baseBranch: string;
	readonly rules: string | null;
	readonly person: PersonConfig;
	// the environment of every session: the machine's, under the profile if one is chosen
	readonly env: Env;
	// the Claude login the sessions bill, said as the check found it; null on the API key
	readonly login: string | null;
	// whose Features to build: the config's assignee, else the signed-in person
	readonly assignee: string;
	// the Workflows that cannot run here, by name, with the reason; the others still can
	readonly workflowProblems: Readonly<Record<string, string>>;
}

interface Report {
	readonly lines: readonly Line[];
	readonly adapters: Adapters | null;
	readonly config: Config | null;
	// whether the Tracker was reached, so something can be set up on it
	readonly trackerOk: boolean;
}

// Ready unless a check stops every build (a failing Workflow stops only the Feature that picks it); else the first refusal.
type Outcome =
	| { readonly ready: Ready; readonly refusal: null }
	| { readonly ready: null; readonly refusal: string };

export type Checked = Report & Outcome;

export interface CheckOptions {
	readonly useApiKey: boolean;
	// the --profile of this run, over the person's own
	readonly profile?: string;
	readonly env: Env;
	readonly cwd: string;
	readonly request?: AzureDevOpsRequest;
	readonly gh?: GhRunner;
	// stop at the first check that fails, as a build does
	readonly failFast: boolean;
	// the skills a headless claude session loads; a spec passes its own
	readonly skills?: LoadedSkills;
	// the clock a schedule's next due time is counted from; a spec passes its own
	readonly now?: () => Date;
	// what the sandbox check reads of the machine; the running process's own unless a spec passes its own
	readonly platform?: NodeJS.Platform;
	// the text of /proc/version
	readonly kernel?: string;
}

// What the checks find, each for the checks after it and for Ready.
export interface Found {
	readonly root: string;
	readonly loaded: { readonly config: Config; readonly rules: string | null };
	readonly person: PersonConfig;
	readonly adapters: Adapters;
	readonly me: string;
	readonly claude: { readonly version: string; readonly login: string | null };
	readonly signs: 'signs' | 'unsigned';
	readonly workflowProblems: Readonly<Record<string, string>>;
}

const CLAUDE_INSTALL = 'https://claude.com/claude-code';

const check = checksOver<Found, CheckOptions>();

// the environment of every session, under the profile --profile or config.json names
const sessionEnv = (o: CheckOptions, person: PersonConfig | undefined) =>
	profileEnv(o.profile ?? person?.profile, o.env);

async function need(command: string, args: readonly string[], cwd: string, env: Env, what: string) {
	const got = await run(command, args, cwd, env);
	if (got.missing) throw new Refusal(`${command} is not on the PATH.`);
	if (!got.ok) throw new Refusal(`${what}: ${firstLine(got.err) || firstLine(got.out)}`);
	return got.out.trim();
}

async function claudeVersion(root: string, env: Env, useApiKey: boolean) {
	const got = await run('claude', ['--version'], root, env);
	if (got.missing) {
		throw new Refusal(
			`claude is not on the PATH. Install Claude Code from ${CLAUDE_INSTALL}, then sign in with \`claude auth login\`.`
		);
	}
	if (!got.ok)
		throw new Refusal(`claude does not start: ${firstLine(got.err) || firstLine(got.out)}`);
	const version = got.out.trim();
	// a session on the API key needs no login of its own
	if (useApiKey) return { version, detail: `${version}, billing ANTHROPIC_API_KEY`, login: null };
	const status = await run('claude', ['auth', 'status', '--json'], root, env);
	const account = parseAccount(status.out);
	if (account?.loggedIn === false || (!status.ok && account === null)) {
		const folder = account?.folder ?? env.CLAUDE_CONFIG_DIR ?? '~/.claude';
		const old =
			account === null
				? ' (It is also unsigned if this claude is too old for `claude auth status --json`.)'
				: '';
		throw new Refusal(
			`claude is not signed in to ${folder}: start claude with that folder and type /login, or pass another --profile.${old}`
		);
	}
	const login = account === null ? 'signed in' : accountLine(account) || 'signed in';
	return { version, detail: `${version}, ${login}`, login };
}

export const apiKeyCheck = check({
	name: 'API key',
	needs: [],
	run: (_found, o) => {
		const problem = apiKeyProblem(o.env, o.useApiKey);
		if (problem) throw new Refusal(problem);
		return {
			detail: o.useApiKey
				? 'ANTHROPIC_API_KEY chosen'
				: 'none set, so sessions bill your Claude plan',
			summary: o.useApiKey ? 'ANTHROPIC_API_KEY chosen' : 'no ANTHROPIC_API_KEY'
		};
	}
});

const nodeCheck = check({
	name: 'Node',
	needs: [],
	run: () => {
		const node = process.versions.node;
		if (Number(node.split('.')[0]) < 24) {
			throw new Refusal(`Node 24 or later is needed, and this is ${node}.`);
		}
		return { detail: node, summary: `Node ${node}` };
	}
});

const checkoutCheck = check({
	name: 'git checkout',
	needs: [],
	run: async (_found, o) => {
		const root = await need(
			'git',
			['rev-parse', '--show-toplevel'],
			o.cwd,
			o.env,
			'not inside a git checkout'
		);
		return { found: { root }, detail: root, summary: null };
	}
});

const factoryCheck = check({
	name: 'factory.json',
	needs: ['root'],
	unmet: 'needs a git checkout',
	run: ({ root }) => {
		const config = loadConfig(root);
		return {
			found: { loaded: { config, rules: loadRules(root, config) } },
			detail: 'read',
			summary: 'factory.json'
		};
	}
});

const personCheck = check({
	name: 'config.json',
	needs: [],
	run: (_found, o) => {
		const person = loadPersonConfig(o.env);
		return {
			found: { person },
			detail: `$${String(person.dailyUsd)} a day, polling every ${String(person.pollSeconds)}s, building for ${person.assignee ?? 'the signed-in person'}`,
			summary: null
		};
	}
});

// builds the Tracker and Code host, saying nothing unless it fails, which is the Tracker's line
const adaptersCheck = check({
	name: 'Tracker',
	needs: ['root', 'loaded'],
	unmet: 'needs a usable factory.json',
	run: async ({ root, loaded }, o) => ({
		found: {
			adapters: await makeAdapters(loaded.config, root, o.env, {
				...(o.request === undefined ? {} : { request: o.request }),
				...(o.gh === undefined ? {} : { gh: o.gh })
			})
		}
	})
});

export const trackerCheck = check({
	name: 'Tracker',
	needs: ['adapters'],
	run: async ({ adapters }) => {
		let me: string;
		try {
			me = await adapters.tracker.me();
		} catch (fault) {
			throw new Refusal(adapters.trackerFix(why(fault)));
		}
		return { found: { me }, detail: adapters.checked(me) };
	}
});

export const codeHostCheck = check({
	name: 'Code host',
	needs: ['adapters'],
	unmet: 'needs a usable factory.json',
	run: async ({ adapters }) => {
		try {
			await adapters.reachCodeHost();
		} catch (fault) {
			throw new Refusal(adapters.codeHostFix(why(fault)));
		}
		return { detail: adapters.repo, summary: null };
	}
});

// a warning only: the pass never runs, but every build still does
export const pullChecksCheck = check({
	name: 'Pull checks',
	needs: ['adapters', 'loaded'],
	unmet: null,
	run: ({ adapters, loaded }) => {
		if (loaded.config.pullChecks?.enabled !== true) return {};
		if (typeof adapters.codeHost.nightjarDrafts === 'function') return {};
		return {
			lines: [
				{
					name: 'Pull checks',
					status: 'warn',
					detail:
						'pullChecks.enabled is on, but this Code host cannot report Pull checks (its Adapter has no nightjarDrafts), so the pass will not run.',
					summary: null
				}
			]
		};
	}
});

// a warning only: an install in allowedCommands cannot fetch in a sandbox, but the build still runs
export const installsCheck = check({
	name: 'allowedCommands',
	needs: ['loaded'],
	unmet: null,
	run: ({ loaded }) => {
		const where = [
			{ of: '', commands: loaded.config.allowedCommands },
			...Object.entries(loaded.config.workflows ?? {}).map(([name, w]) => ({
				of: `Workflow ${name}: `,
				commands: w.allowedCommands ?? []
			}))
		];
		const lines = where.flatMap(({ of, commands }) =>
			commands.flatMap((command): Line[] =>
				installCommand(command) === null
					? []
					: [
							{
								name: 'allowedCommands',
								status: 'warn',
								detail: `${of}"${command}" installs packages, and a Session has no network to fetch them; move it to "setup", which Nightjar runs itself.`,
								summary: null
							}
						]
			)
		);
		return { lines };
	}
});

const claudeCheck = check({
	name: 'claude',
	needs: ['root'],
	run: async ({ root, person }, o) => {
		const { version, detail, login } = await claudeVersion(
			root,
			sessionEnv(o, person),
			o.useApiKey
		);
		return { found: { claude: { version, login } }, detail, summary: `claude ${version}` };
	}
});

const signingCheck = check({
	name: 'git signing',
	needs: ['root'],
	run: async ({ root }, o) => {
		const signs = await signing(root, o.env);
		if (signs === 'fails') {
			throw new Refusal('git cannot sign a commit; unlock your signing key and run again.');
		}
		const detail = signs === 'signs' ? 'git signs commits' : 'commits unsigned';
		return { found: { signs }, detail, summary: detail };
	}
});

// a Workflow's missing skill is an error for that Workflow only, so each says a line of its own
const workflowsCheck = check({
	name: 'Workflows',
	needs: ['root', 'claude'],
	run: async ({ root, loaded }, o) => {
		const named = Object.entries(loaded?.config.workflows ?? {}).map(([name, w]) => ({
			name,
			localNetwork: w.localNetwork === true,
			steps: w.steps.map((s) => ({ step: s.name, skills: skillsNamed(s.prompt) }))
		}));
		if (named.length === 0) return { found: { workflowProblems: {} } };
		// only a Workflow with localNetwork needs the sandbox, so the machine is asked only then
		const sandbox = named.some((w) => w.localNetwork)
			? await sandboxFinding(o.platform ?? process.platform, o.env, o.kernel ?? readKernel(), root)
			: { fault: null, caution: null };
		const wanted = named.some((w) => w.steps.some((s) => s.skills.length > 0));
		const skills = wanted
			? await (o.skills ?? loadedSkills)(
					root,
					o.env,
					(loaded?.config.plugins ?? []).map((p) => join(root, p))
				)
			: [];
		const workflowProblems: Record<string, string> = {};
		const lines = named.map((w): Line => {
			const said = { name: `Workflow ${w.name}`, summary: null, only: w.name };
			const missing = w.steps.flatMap((s) =>
				s.skills
					.filter((k) => skills !== null && !isLoaded(skills, k))
					.map((k) => `step ${s.step} names /${k}`)
			);
			const used = [...new Set(w.steps.flatMap((s) => s.skills))];
			const faults: string[] = [];
			if (skills === null && used.length > 0) {
				faults.push(
					'could not list the skills a headless claude session loads, so /skills in its Steps are unchecked'
				);
			}
			if (missing.length > 0) {
				faults.push(
					`${missing.join(' and ')}, which a headless claude session does not load. Sessions load no skill from the repo's own .claude/skills; add the folder that holds it to "plugins" in factory.json (for example [".claude"]), then run \`nightjar doctor\` again.`
				);
			}
			// a Step with localNetwork must not run unsandboxed, so a machine that cannot sandbox refuses the Workflow
			if (w.localNetwork && sandbox.fault !== null) {
				faults.push(`localNetwork needs the sandbox, and ${sandbox.fault}`);
			}
			if (faults.length > 0) {
				const detail = faults.join('\n');
				workflowProblems[w.name] = detail;
				return { ...said, status: 'fail', detail };
			}
			const count = `${String(w.steps.length)} Step${w.steps.length === 1 ? '' : 's'}`;
			const detail = `${count}${used.length > 0 ? `, skills found: ${used.map((k) => `/${k}`).join(', ')}` : ''}`;
			if (w.localNetwork && sandbox.caution !== null) {
				return { ...said, status: 'warn', detail: `${detail}\nlocalNetwork: ${sandbox.caution}` };
			}
			return { ...said, status: 'ok', detail };
		});
		return { found: { workflowProblems }, lines };
	}
});

// A Source's fault does not stop a build, which never reads Sources: each says a line of its own, as a Workflow does.
const sourcesCheck = check({
	name: 'Sources',
	needs: ['root', 'loaded'],
	run: async ({ root, loaded, adapters, me }, o) => {
		const lines: Line[] = [];
		for (const [name, source] of Object.entries(loaded.config.sources ?? {})) {
			const said = { name: `Source ${name}`, summary: null, source: name };
			const faults = templateFaults(root, source.template).map(
				(f) => `template ${source.template}: ${f}`
			);
			// the same refusal intake makes before it starts
			if (source.go === true && source.owner !== undefined) {
				const fault =
					adapters === undefined || me === undefined
						? `the owner ${source.owner} cannot be checked until the Tracker is reached`
						: await goFault(adapters.tracker, source.owner, loaded.config.trusted);
				if (fault !== null) faults.push(fault);
			}
			lines.push(sourceLine(said, source, faults, o));
		}
		return { lines };
	}
});

// The line of one Source: its faults, or what it is and when a schedule is next due.
function sourceLine(
	said: Pick<Line, 'name' | 'summary' | 'source'>,
	source: NonNullable<Config['sources']>[string],
	faults: readonly string[],
	o: CheckOptions
): Line {
	const all = [...faults];
	if (source.type !== 'schedule') {
		if (source.secretEnv === undefined) {
			all.push('name the variable that holds its webhook secret, as secretEnv');
		} else if ((o.env[source.secretEnv] ?? '') === '') {
			all.push(
				`${source.secretEnv} is not set; put the webhook secret in that variable, never in factory.json`
			);
		}
	}
	if (all.length > 0) return { ...said, status: 'fail', detail: all.join('\n') };
	const go = source.go === true ? `, gives the Go for ${source.owner ?? ''}` : '';
	if (source.type !== 'schedule') {
		return {
			...said,
			status: 'ok',
			detail: `${source.type}, template ${source.template} is in shape${go}`
		};
	}
	// factory.json has loaded, so the cron time reads; intake fires it in the machine's local time zone
	const next = nextDue(parseCron(source.cron ?? ''), o.now?.() ?? new Date());
	return {
		...said,
		status: 'ok',
		detail: `schedule ${source.cron ?? ''}, next due ${next === null ? 'never' : localTime(next)}, template ${source.template} is in shape${go}`
	};
}

// In the order doctor lists them.
export const CHECKS: readonly Check<Found, CheckOptions>[] = [
	apiKeyCheck,
	nodeCheck,
	checkoutCheck,
	factoryCheck,
	personCheck,
	adaptersCheck,
	trackerCheck,
	codeHostCheck,
	pullChecksCheck,
	installsCheck,
	claudeCheck,
	signingCheck,
	workflowsCheck,
	sourcesCheck
];

export async function checkMachine(o: CheckOptions): Promise<Checked> {
	const { lines, found, failed } = await runChecks(CHECKS, o, o.failFast);
	const { root, loaded, person, adapters, me, claude, signs, workflowProblems } = found;
	const report: Report = {
		lines,
		adapters: adapters ?? null,
		config: loaded?.config ?? null,
		trackerOk: me !== undefined
	};
	if (
		failed !== null ||
		root === undefined ||
		loaded === undefined ||
		person === undefined ||
		adapters === undefined ||
		me === undefined ||
		claude === undefined ||
		signs === undefined
	) {
		return { ...report, ready: null, refusal: failed?.detail ?? 'the checks did not finish' };
	}
	const ready: Ready = {
		env: sessionEnv(o, person),
		login: claude.login,
		root,
		config: loaded.config,
		adapters,
		me,
		baseBranch: (await defaultBranch(root, o.env)) ?? 'main',
		rules: loaded.rules,
		person,
		assignee: person.assignee ?? me,
		workflowProblems: workflowProblems ?? {}
	};
	return { ...report, ready, refusal: null };
}
