// `doctor` and `init` run every check and list each; a build stops at the first that fails. Each failure says how to fix it.
import { makeAdapters, type Adapters } from './adapters.js';
import { apiKeyProblem } from './args.js';
import type { AzureDevOpsRequest } from './azure-devops/index.js';
import { loadConfig, loadRules, type Config } from './config.js';
import { loadPersonConfig, type PersonConfig } from './person-config.js';
import { firstLine, run, type Env } from './git.js';
import { isLoaded, loadedSkills, type LoadedSkills } from './skills.js';
import { skillsNamed } from './workflow.js';
import { defaultBranch, signing } from './worktree.js';
import { why } from './say.js';

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
	// whose Features to build: the config's assignee, else the signed-in person
	readonly assignee: string;
	// the Workflows that cannot run here, by name, with the reason; the others still can
	readonly workflowProblems: Readonly<Record<string, string>>;
}

export interface Line {
	readonly name: string;
	readonly status: 'ok' | 'fail' | 'skip';
	// what was found, or why it failed and how to fix it
	readonly detail: string;
	// the check as the one-line `checked:` of a build names it; none when it is left out
	readonly summary: string | null;
	// the one Workflow this line is an error for; it stops no other Workflow and no build of its own
	readonly only?: string;
}

export interface Checked {
	readonly lines: readonly Line[];
	// set when every check passed
	readonly ready: Ready | null;
	readonly adapters: Adapters | null;
	readonly config: Config | null;
	// whether the Tracker was reached, so something can be set up on it
	readonly trackerOk: boolean;
}

export interface CheckOptions {
	readonly useApiKey: boolean;
	readonly env: Env;
	readonly cwd: string;
	readonly request?: AzureDevOpsRequest;
	// stop at the first check that fails, as a build does
	readonly failFast: boolean;
	// the skills a headless claude session loads; a spec passes its own
	readonly skills?: LoadedSkills;
}

const GH_INSTALL = 'https://cli.github.com/';
const CLAUDE_INSTALL = 'https://claude.com/claude-code';

const ghFix = (message: string) =>
	message.includes('is not on the PATH')
		? `${message} Install it from ${GH_INSTALL}, then run \`gh auth login\`.`
		: `${message} If gh is not signed in, run \`gh auth login\`.`;

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
	if (useApiKey) return { version, detail: `${version}, billing ANTHROPIC_API_KEY` };
	const status = await run('claude', ['auth', 'status'], root, env);
	if (!status.ok) {
		throw new Refusal(
			'claude is not signed in: run `claude auth login`. (It is also unsigned if this claude is too old for `claude auth status`.)'
		);
	}
	return { version, detail: `${version}, signed in` };
}

export async function checkMachine(o: CheckOptions): Promise<Checked> {
	const lines: Line[] = [];
	const stopped = () => o.failFast && lines.some((l) => l.status === 'fail');

	async function step<T>(
		name: string,
		fn: () => Promise<T> | T,
		said: (value: T) => { detail: string; summary?: string | null }
	): Promise<T | null> {
		if (stopped()) return null;
		try {
			const value = await fn();
			const { detail, summary } = said(value);
			lines.push({ name, status: 'ok', detail, summary: summary === undefined ? detail : summary });
			return value;
		} catch (fault) {
			// a config fault names its file in every line already
			const detail = why(fault).replace(/^factory\.json: /gm, '');
			lines.push({ name, status: 'fail', detail, summary: null });
			return null;
		}
	}
	const skip = (name: string, because: string) => {
		if (!stopped()) lines.push({ name, status: 'skip', detail: because, summary: null });
	};

	const keyProblem = apiKeyProblem(o.env, o.useApiKey);
	const key = await step(
		'API key',
		() => {
			if (keyProblem) throw new Refusal(keyProblem);
			return o.useApiKey;
		},
		(chosen) => ({
			detail: chosen ? 'ANTHROPIC_API_KEY chosen' : 'none set, so sessions bill your Claude plan',
			summary: chosen ? 'ANTHROPIC_API_KEY chosen' : 'no ANTHROPIC_API_KEY'
		})
	);
	const node = process.versions.node;
	await step(
		'Node',
		() => {
			if (Number(node.split('.')[0]) < 24) {
				throw new Refusal(`Node 24 or later is needed, and this is ${node}.`);
			}
			return node;
		},
		(version) => ({ detail: version, summary: `Node ${version}` })
	);
	const root = await step(
		'git checkout',
		() => need('git', ['rev-parse', '--show-toplevel'], o.cwd, o.env, 'not inside a git checkout'),
		(path) => ({ detail: path, summary: null })
	);
	const loaded =
		root === null
			? null
			: await step(
					'factory.json',
					() => {
						const config = loadConfig(root);
						return { config, rules: loadRules(root, config) };
					},
					() => ({ detail: 'read', summary: 'factory.json' })
				);
	if (root === null) skip('factory.json', 'needs a git checkout');
	const person = await step(
		'config.json',
		() => loadPersonConfig(o.env),
		(p) => ({
			detail: `$${String(p.dailyUsd)} a day, building for ${p.assignee ?? 'the signed-in person'}`,
			summary: null
		})
	);

	let adapters: Adapters | null = null;
	let faulty = false;
	if (loaded !== null && root !== null) {
		try {
			adapters = await makeAdapters(loaded.config, root, o.env, o.request);
		} catch (fault) {
			faulty = true;
			const detail = why(fault).replace(/^factory\.json: /gm, '');
			if (!stopped()) {
				lines.push({ name: 'Tracker', status: 'fail', detail, summary: null });
			}
		}
	}
	let me: string | null = null;
	if (adapters !== null && loaded !== null) {
		const { tracker, codeHost } = loaded.config;
		const github = (type: string, fix: (m: string) => string) => (type === 'github' ? fix : why);
		const trackerFix = github(tracker.type, ghFix);
		const hostFix = github(codeHost.type, ghFix);
		const found = adapters;
		me = await step(
			'Tracker',
			async () => {
				try {
					return await found.tracker.me();
				} catch (fault) {
					throw new Refusal(trackerFix(why(fault)));
				}
			},
			(person) => ({ detail: found.checked(person) })
		);
		await step(
			'Code host',
			async () => {
				try {
					await found.reachCodeHost();
				} catch (fault) {
					throw new Refusal(hostFix(why(fault)));
				}
			},
			() => ({ detail: found.repo, summary: null })
		);
	} else if (!faulty) {
		skip('Tracker', 'needs a usable factory.json');
		skip('Code host', 'needs a usable factory.json');
	} else {
		skip('Code host', 'needs a usable factory.json');
	}

	const claude =
		root === null
			? null
			: await step(
					'claude',
					() => claudeVersion(root, o.env, o.useApiKey),
					({ version, detail }) => ({ detail, summary: `claude ${version}` })
				);
	const signs =
		root === null
			? null
			: await step(
					'git signing',
					async () => {
						const got = await signing(root, o.env);
						if (got === 'fails') {
							throw new Refusal('git cannot sign a commit; unlock your signing key and run again.');
						}
						return got;
					},
					(got) => {
						const detail = got === 'signs' ? 'git signs commits' : 'commits unsigned';
						return { detail, summary: detail };
					}
				);

	// a Workflow's missing skill is an error for that Workflow only
	const workflowProblems: Record<string, string> = {};
	const workflows = Object.entries(loaded?.config.workflows ?? {});
	const named = workflows.map(([name, w]) => ({
		name,
		steps: w.steps.map((s) => ({ step: s.name, skills: skillsNamed(s.prompt) }))
	}));
	if (root !== null && claude !== null && named.length > 0) {
		const wanted = named.some((w) => w.steps.some((s) => s.skills.length > 0));
		const skills = wanted ? await (o.skills ?? loadedSkills)(root, o.env) : [];
		for (const w of named) {
			const missing = w.steps.flatMap((s) =>
				s.skills
					.filter((k) => skills !== null && !isLoaded(skills, k))
					.map((k) => `step ${s.step} names /${k}`)
			);
			const used = [...new Set(w.steps.flatMap((s) => s.skills))];
			if (skills === null && used.length > 0) {
				const detail =
					'could not list the skills a headless claude session loads, so /skills in its Steps are unchecked';
				workflowProblems[w.name] = detail;
				lines.push({
					name: `Workflow ${w.name}`,
					status: 'fail',
					detail,
					summary: null,
					only: w.name
				});
			} else if (missing.length > 0) {
				const detail = `${missing.join(' and ')}, which a headless claude session does not load. Install the skill in this repo or your plugins, then run \`nightjar doctor\` again.`;
				workflowProblems[w.name] = detail;
				lines.push({
					name: `Workflow ${w.name}`,
					status: 'fail',
					detail,
					summary: null,
					only: w.name
				});
			} else {
				const count = `${String(w.steps.length)} Step${w.steps.length === 1 ? '' : 's'}`;
				const detail = `${count}${used.length > 0 ? `, skills found: ${used.map((k) => `/${k}`).join(', ')}` : ''}`;
				lines.push({
					name: `Workflow ${w.name}`,
					status: 'ok',
					detail,
					summary: null,
					only: w.name
				});
			}
		}
	}

	const trackerOk = me !== null;
	let ready: Ready | null = null;
	if (
		key !== null &&
		root !== null &&
		loaded !== null &&
		adapters !== null &&
		me !== null &&
		claude !== null &&
		signs !== null &&
		person !== null &&
		lines.every((l) => l.status === 'ok' || l.only !== undefined)
	) {
		const baseBranch = (await defaultBranch(root, o.env)) ?? 'main';
		ready = {
			root,
			config: loaded.config,
			adapters,
			me,
			baseBranch,
			rules: loaded.rules,
			person,
			assignee: person.assignee ?? me,
			workflowProblems
		};
	}
	return { lines, ready, adapters, config: loaded?.config ?? null, trackerOk };
}
