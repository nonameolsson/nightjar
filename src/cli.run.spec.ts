// `nightjar 1` end to end: the real command, build loop, GitHub adapters and session, with stand-ins
// for gh and claude first on PATH, over a clone of a bare origin. The other specs cut this chain at
// the seams; this one runs it whole, as a first real run would.
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PACKAGE = join(import.meta.dirname, '..');
const TSX = join(PACKAGE, 'node_modules', '.bin', 'tsx');
const CLI = join(PACKAGE, 'src', 'cli.ts');

let base: string;
beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-run-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function script(dir: string, name: string, body: string) {
	const path = join(dir, name);
	writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
	chmodSync(path, 0o755);
}

// gh: one Feature, #1, with one Ticket, #2; every call is kept in $FAKE_GH_CALLS
const GH = String.raw`
echo "$*" >> "$FAKE_GH_CALLS"
issue() { printf '{"number":%s,"title":"%s","body":"","state":"open","labels":[{"name":"ready-for-agent"}],"assignees":[{"login":"ann"}],"user":{"login":"ann"}%s}' "$1" "$2" "$3"; }
for a in "$@"; do case "$a" in
  user) echo '{"login":"ann"}'; exit 0 ;;
  repos/o/r/issues\?*) echo "[$(issue 1 'One escape' ',"sub_issues_summary":{"total":1}')]"; exit 0 ;;
  repos/o/r/issues/1) issue 1 "One escape" ',"sub_issues_summary":{"total":1}'; exit 0 ;;
  repos/o/r/issues/1/sub_issues*)
    [ -n "$FAKE_GH_FAIL_TICKETS" ] && { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }
    echo "[$(issue 2 'Share the escape' '')]"; exit 0 ;;
  repos/o/r/issues/*/dependencies/*) echo '[]'; exit 0 ;;
  repos/o/r/issues/*/comments*) echo '[]'; exit 0 ;;
  repos/o/r/issues/*/labels*) echo '[]'; exit 0 ;;
  repos/o/r/pulls\?*) echo '[]'; exit 0 ;;
  repos/o/r/pulls|repos/o/r/pulls/9) echo '{"number":9,"html_url":"https://github.com/o/r/pull/9","body":""}'; exit 0 ;;
esac; done
echo "gh: Not Found (HTTP 404)" >&2; exit 1`;

// claude: a build writes a file in the worktree and answers built; a review approves
const CLAUDE = String.raw`
[ "$1" = --version ] && { echo "2.1.314 (Claude Code)"; exit 0; }
echo "$*" >> "$FAKE_CLAUDE_CALLS"
case "$*" in
  *verdict*) out='{"verdict":"approve","summary":"Reads well.","issues":[]}' ;;
  *) echo work > built.txt; echo "${'$'}{WEB_PORT:-none}" > port.txt; out='{"outcome":"built","summary":"Shared it.","questions":[]}' ;;
esac
echo '{"type":"system","subtype":"init","apiKeySource":"none"}'
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"total_cost_usd\":0.5,\"structured_output\":$out}"`;

// green, or with FAKE_CHECK_RED red, with colour codes as a real check prints them
const CHECK = String.raw`[ -z "$FAKE_CHECK_RED" ] || { printf '\033[31mred: a failing check\033[0m\n'; exit 1; }`;

function world(withConfig = true, extraConfig: Record<string, unknown> = {}) {
	const bin = join(base, 'bin');
	mkdirSync(bin);
	script(bin, 'gh', GH);
	script(bin, 'claude', CLAUDE);
	const gitconfig = join(base, 'gitconfig');
	writeFileSync(gitconfig, '');
	const env: Record<string, string> = {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				(e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('GIT_')
			)
		),
		PATH: `${bin}:${process.env.PATH ?? ''}`,
		HOME: join(base, 'home'),
		GIT_CONFIG_GLOBAL: gitconfig,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_AUTHOR_NAME: 'Test',
		GIT_AUTHOR_EMAIL: 'test@example.com',
		GIT_COMMITTER_NAME: 'Test',
		GIT_COMMITTER_EMAIL: 'test@example.com',
		// the port locks live in the temporary folder, so each run of the spec has its own
		TMPDIR: base,
		FAKE_GH_CALLS: join(base, 'gh-calls.txt'),
		FAKE_CLAUDE_CALLS: join(base, 'claude-calls.txt')
	};
	delete env.ANTHROPIC_API_KEY;
	// the person's own config.json is read under HOME alone
	delete env.XDG_CONFIG_HOME;
	const git = (cwd: string, ...args: string[]) =>
		spawnSync('git', args, { cwd, env, encoding: 'utf8' }).stdout.trim();
	const origin = join(base, 'origin.git');
	const root = join(base, 'app');
	git(base, 'init', '-q', '--bare', '-b', 'main', origin);
	git(base, 'clone', '-q', origin, root);
	writeFileSync(join(root, 'README.md'), 'hello\n');
	if (withConfig) {
		const config = {
			tracker: { type: 'github', repo: 'o/r' },
			codeHost: { type: 'github', repo: 'o/r' },
			check: CHECK,
			allowedCommands: ['make test'],
			...extraConfig
		};
		writeFileSync(join(root, 'factory.json'), JSON.stringify(config, null, '\t'));
	}
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'first');
	git(root, 'push', '-q', 'origin', 'main');
	const nightjar = (args: string[], extra: Record<string, string> = {}) =>
		spawnSync(TSX, [CLI, ...args], {
			cwd: root,
			env: { ...env, ...extra },
			encoding: 'utf8',
			timeout: 25_000
		});
	const calls = () => readFileSync(env.FAKE_GH_CALLS ?? '', 'utf8');
	const sessions = () => readFileSync(env.FAKE_CLAUDE_CALLS ?? '', 'utf8');
	return { root, env, git, origin, nightjar, calls, sessions };
}

describe('nightjar FEATURE', () => {
	it('takes a Feature from the Go to a draft pull request', () => {
		const { root, env, git, origin, nightjar, calls } = world();
		const run = nightjar(['1']);
		expect(run.stderr).toBe('');
		expect(run.stdout).toContain('nightjar: #1: draft pull request https://github.com/o/r/pull/9');
		expect(run.status).toBe(0);

		const branch = 'factory/1-one-escape';
		expect(git(origin, 'log', '--format=%s', branch)).toContain('Share the escape (#2)');
		expect(calls()).toMatch(/-X POST repos\/o\/r\/pulls /);
		expect(calls()).toMatch(/-X PATCH repos\/o\/r\/pulls\/9 -f body=[\s\S]*Closes #2/);
		// the claim is taken back off at the end
		expect(calls()).toMatch(/-X DELETE repos\/o\/r\/issues\/1\/labels\/agent-working/);

		// the worktree sits under ~/.nightjar, out of the checkout
		const trees = join(env.HOME ?? '', '.nightjar', 'worktrees');
		const [folder] = readdirSync(trees);
		expect(folder).toMatch(/^app-[0-9a-f]{8}$/);
		expect(existsSync(join(trees, folder ?? '', '1-one-escape', 'built.txt'))).toBe(true);

		const ledger = readFileSync(join(root, '.factory', 'runs.jsonl'), 'utf8')
			.trim()
			.split('\n');
		expect(ledger).toHaveLength(2);
		const session = (JSON.parse(ledger[0] ?? '{}') as { session: string }).session;
		expect(existsSync(join(root, '.factory', 'logs', `${session}.jsonl`))).toBe(true);

		const status = JSON.parse(readFileSync(join(root, '.factory', 'status.json'), 'utf8')) as {
			doing: unknown;
			spentTodayUsd: number;
			recent: unknown[];
		};
		expect(status.doing).toEqual({ kind: 'off' });
		expect(status.spentTodayUsd).toBe(1);
		expect(status.recent).toMatchObject([
			{ kind: 'built', feature: '1', ticket: '2', seq: 1 },
			{ kind: 'pull', feature: '1', url: 'https://github.com/o/r/pull/9', seq: 2 }
		]);
	}, 30_000);

	it('hands the configured check output on, without colour codes, when it stays red', () => {
		const { nightjar, calls } = world();
		const run = nightjar(['1'], { FAKE_CHECK_RED: '1' });
		expect(run.status).toBe(0);
		const pull = calls().slice(calls().indexOf('-X POST repos/o/r/pulls '));
		expect(pull).toContain('## The check fails');
		expect(pull).toContain('red: a failing check');
		expect(pull).not.toContain('\u001b');
	}, 30_000);

	it('hands the Feature back, claim off and reason said, when a step fails', () => {
		const { root, nightjar, calls } = world();
		const run = nightjar(['1'], { FAKE_GH_FAIL_TICKETS: '1' });
		expect(run.stdout).toContain(
			'nightjar: #1 failed: gh could not list the sub-issues of #1: gh: Bad Gateway (HTTP 502)'
		);
		expect(run.status).toBe(1);
		expect(calls()).toMatch(/-X DELETE repos\/o\/r\/issues\/1\/labels\/agent-working/);
		expect(calls()).toMatch(/-X POST repos\/o\/r\/issues\/1\/labels -f labels\[\]=needs-info/);
		expect(calls()).toMatch(
			/-X POST repos\/o\/r\/issues\/1\/comments -f body=Nightjar stopped on a fault/
		);
		const status = JSON.parse(readFileSync(join(root, '.factory', 'status.json'), 'utf8')) as {
			recent: unknown[];
		};
		expect(status.recent).toMatchObject([{ kind: 'failed', feature: '1' }]);
	}, 30_000);
});

// a Tracker module whose items are keyed as Jira or Linear keys them, held in the process
const KEYED_TRACKER = `const items = {
	'PROJ-1': { title: 'One escape', signals: ['go'], children: ['PROJ-2'] },
	'PROJ-2': { title: 'Share the escape', signals: ['ready'], children: [] }
};
const said = [];
export const createTracker = () => ({
	me: async () => 'ann',
	assignedFeatures: async () => [],
	feature: async (id) => ({ id, title: items[id].title, body: '' }),
	tickets: async (id) => items[id].children.map((c) => ({
		id: c, title: items[c].title, body: '', open: true, signals: [...items[c].signals], blockedBy: []
	})),
	comments: async () => [],
	addSignal: async (id, s) => { items[id].signals.push(s); },
	removeSignal: async (id, s) => { items[id].signals = items[id].signals.filter((x) => x !== s); },
	comment: async (id, body) => { said.push([id, body]); },
	reference: (id) => ({ id, text: id })
});`;

describe('nightjar FEATURE on a Tracker module keyed by strings', () => {
	it('builds PROJ-1 and names its Tickets by their own keys', () => {
		const { root, git, origin, nightjar, calls } = world(true, {
			tracker: { type: 'module', path: './tracker.mjs' }
		});
		writeFileSync(join(root, 'tracker.mjs'), KEYED_TRACKER);
		git(root, 'add', '.');
		git(root, 'commit', '-q', '-m', 'tracker');
		const run = nightjar(['PROJ-1']);
		expect(run.stderr).toBe('');
		expect(run.stdout).toContain('nightjar: #PROJ-1: draft pull request');
		expect(run.status).toBe(0);
		const branch = 'factory/PROJ-1-one-escape';
		expect(git(origin, 'log', '--format=%B', branch)).toContain('Factory-Ticket: #PROJ-2');
		expect(calls()).toMatch(/-X PATCH repos\/o\/r\/pulls\/9 -f body=[\s\S]*PROJ-2/);
		const ledger = readFileSync(join(root, '.factory', 'runs.jsonl'), 'utf8');
		expect(JSON.parse(ledger.split('\n')[0] ?? '{}')).toMatchObject({
			feature: 'PROJ-1',
			ticket: 'PROJ-2'
		});
		const status = JSON.parse(readFileSync(join(root, '.factory', 'status.json'), 'utf8')) as {
			recent: unknown[];
		};
		expect(status.recent).toMatchObject([
			{ kind: 'built', feature: 'PROJ-1', ticket: 'PROJ-2' },
			{ kind: 'pull', feature: 'PROJ-1' }
		]);
	}, 30_000);
});

describe("the person's own config.json", () => {
	const own = (env: Record<string, string>, value: unknown) => {
		const folder = join(env.HOME ?? '', '.config', 'nightjar');
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, 'config.json'), JSON.stringify(value));
	};

	it('caps the day at its dailyUsd and builds the Features of its assignee', () => {
		const { root, env, nightjar, calls } = world();
		own(env, { dailyUsd: 25, assignee: 'zed' });
		expect(nightjar(['doctor']).status).toBe(0);
		expect(calls()).toMatch(/repos\/o\/r\/issues\?[^\n]*assignee=zed/);
		const run = nightjar(['--once']);
		expect(run.stdout).toContain('building the Features assigned to zed');
		const status = JSON.parse(readFileSync(join(root, '.factory', 'status.json'), 'utf8')) as {
			dailyUsd: number;
		};
		expect(status.dailyUsd).toBe(25);
	}, 30_000);

	it('refuses to start when a field is wrong, naming it', () => {
		const { env, nightjar } = world();
		own(env, { dailyUsd: 'lots' });
		const run = nightjar(['doctor']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('config.json: dailyUsd: ');
	}, 30_000);
});

describe('nightjar FEATURE with factory.json settings', () => {
	it('runs the sessions on the configured model, with the rules file, and no review when it is off', () => {
		const settings = {
			model: 'haiku',
			effort: 'low',
			rules: 'rules.md',
			review: { enabled: false }
		};
		const { root, git, nightjar, sessions } = world(true, settings);
		writeFileSync(join(root, 'rules.md'), 'Name every variable after a bird.\n');
		git(root, 'add', '.');
		git(root, 'commit', '-q', '-m', 'rules');
		const run = nightjar(['1']);
		expect(run.stderr).toBe('');
		expect(run.status).toBe(0);
		const calls = sessions();
		// one build and no review
		expect(calls.match(/--session-id/g)).toHaveLength(1);
		expect(calls).toContain('--model haiku --effort low');
		expect(calls).toContain('Name every variable after a bird.');
	}, 30_000);

	it('refuses to start when the rules file named cannot be read', () => {
		const { nightjar } = world(true, { rules: 'missing.md' });
		const run = nightjar(['doctor']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('factory.json: rules: cannot read missing.md');
	}, 30_000);
});

describe('nightjar FEATURE with a setup command and reserved ports', () => {
	const tree = (env: Record<string, string>) => {
		const trees = join(env.HOME ?? '', '.nightjar', 'worktrees');
		const [folder] = readdirSync(trees);
		return join(trees, folder ?? '', '1-one-escape');
	};

	it('runs the setup in the new worktree and gives the session the reserved ports, held until it ends', () => {
		const config = { setup: 'echo ready > setup.txt', ports: { count: 3, env: ['WEB_PORT'] } };
		const { env, nightjar } = world(true, config);
		const run = nightjar(['1']);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain('nightjar: ports 4477 to 4479');
		expect(readFileSync(join(tree(env), 'setup.txt'), 'utf8')).toBe('ready\n');
		expect(readFileSync(join(tree(env), 'port.txt'), 'utf8')).toBe('4477\n');
		// the locks are given back when the run ends
		expect(readdirSync(join(env.TMPDIR ?? '', 'nightjar-ports'))).toEqual([]);
	}, 30_000);

	it('stops the Feature with a comment when the setup fails, before any session', () => {
		const { env, nightjar, calls } = world(true, { setup: 'echo no network; exit 3' });
		nightjar(['1']);
		expect(calls()).toMatch(
			/-X POST repos\/o\/r\/issues\/1\/comments -f body=Nightjar built nothing: the setup command `echo no network; exit 3` failed[\s\S]*no network/
		);
		expect(existsSync(join(tree(env), 'built.txt'))).toBe(false);
	}, 30_000);

	it('holds no port and runs no setup when neither is configured', () => {
		const { env, nightjar } = world();
		const run = nightjar(['1']);
		expect(run.stdout).not.toContain('ports');
		expect(readFileSync(join(tree(env), 'port.txt'), 'utf8')).toBe('none\n');
		expect(existsSync(join(env.TMPDIR ?? '', 'nightjar-ports'))).toBe(false);
	}, 30_000);
});

describe('nightjar --once', () => {
	it('builds the oldest Feature assigned to the person with the Go, then exits', () => {
		const { nightjar } = world();
		const run = nightjar(['--once']);
		expect(run.stdout).toContain(
			`nightjar: checked: no ANTHROPIC_API_KEY, Node ${process.versions.node}, factory.json, gh as ann on o/r, claude 2.1.314 (Claude Code), commits unsigned`
		);
		expect(run.stdout).toContain('nightjar: #1: draft pull request https://github.com/o/r/pull/9');
		expect(run.status).toBe(0);
	}, 30_000);
});

describe('nightjar doctor', () => {
	it('names each check it passed, and what it would build', () => {
		const { nightjar, calls } = world();
		const run = nightjar(['doctor']);
		expect(run.stdout).toContain('  ok    Tracker: gh as ann on o/r');
		expect(run.stdout).toContain('  ok    claude: 2.1.314 (Claude Code), signed in');
		expect(run.stdout).toContain('nightjar: would build #1 One escape');
		expect(run.status).toBe(0);
		expect(calls()).not.toMatch(/-X (POST|PATCH|DELETE)/);
	}, 30_000);

	it('looks for the Go under the name factory.json gives it', () => {
		const { nightjar, calls } = world(true, { signals: { go: 'ship-it' } });
		const run = nightjar(['doctor']);
		expect(run.status).toBe(0);
		expect(calls()).toMatch(/repos\/o\/r\/issues\?[^\n]*labels=ship-it/);
	}, 30_000);

	it('looks for factory-go unless factory.json names the Go', () => {
		const { nightjar, calls } = world();
		nightjar(['doctor']);
		expect(calls()).toMatch(/repos\/o\/r\/issues\?[^\n]*labels=factory-go/);
	}, 30_000);

	it('refuses a Signal named needs-triage, naming the field', () => {
		const { nightjar } = world(true, { signals: { human: 'needs-triage' } });
		const run = nightjar(['doctor']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('factory.json: signals.human: ');
	}, 30_000);

	it('refuses to start without a factory.json, and says why', () => {
		const { root, nightjar } = world(false);
		const run = nightjar(['doctor']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain(`FAIL  factory.json: no factory.json in ${root}`);
	}, 30_000);

	it("reads the Features from the Tracker module factory.json names, resolved from the repo's root", () => {
		const { root, nightjar } = world(true, {
			tracker: { type: 'module', path: './tools/tracker.mjs', options: { who: 'zed' } }
		});
		mkdirSync(join(root, 'tools'));
		writeFileSync(
			join(root, 'tools', 'tracker.mjs'),
			`export const createTracker = ({ options }) => ({
	me: async () => options.who,
	assignedFeatures: async (person) => [{ id: 7, title: 'Seen by ' + person, body: '' }],
	feature: async () => { throw new Error('unused'); },
	tickets: async () => [],
	comments: async () => [],
	addSignal: async () => {},
	removeSignal: async () => {},
	comment: async () => {},
	reference: (id) => ({ id, text: '#' + id })
});`
		);
		const run = nightjar(['doctor']);
		expect(run.stderr).toBe('');
		expect(run.stdout).toContain('./tools/tracker.mjs as zed');
		expect(run.stdout).toContain('nightjar: would build #7 Seen by zed');
		expect(run.status).toBe(0);
	}, 30_000);

	it('refuses to start when the Tracker module lacks what it must export, naming it', () => {
		const { root, nightjar } = world(true, {
			tracker: { type: 'module', path: './tracker.mjs' }
		});
		writeFileSync(join(root, 'tracker.mjs'), 'export const createTracker = () => ({ me() {} });');
		const run = nightjar(['doctor']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain(
			'FAIL  Tracker: tracker: createTracker in ./tracker.mjs returned a Tracker without these methods: assignedFeatures, feature,'
		);
	}, 30_000);
});
