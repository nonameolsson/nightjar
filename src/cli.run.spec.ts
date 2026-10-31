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
  *) echo work > built.txt; out='{"outcome":"built","summary":"Shared it.","questions":[]}' ;;
esac
echo '{"type":"system","subtype":"init","apiKeySource":"none"}'
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"total_cost_usd\":0.5,\"structured_output\":$out}"`;

// green, or with FAKE_CHECK_RED red, with colour codes as a real check prints them
const CHECK = String.raw`[ -z "$FAKE_CHECK_RED" ] || { printf '\033[31mred: a failing check\033[0m\n'; exit 1; }`;

function world(withConfig = true, extraConfig: object = {}) {
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
		FAKE_GH_CALLS: join(base, 'gh-calls.txt'),
		FAKE_CLAUDE_CALLS: join(base, 'claude-calls.txt')
	};
	delete env.ANTHROPIC_API_KEY;
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
			{ kind: 'built', feature: 1, ticket: 2, seq: 1 },
			{ kind: 'pull', feature: 1, url: 'https://github.com/o/r/pull/9', seq: 2 }
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
		expect(status.recent).toMatchObject([{ kind: 'failed', feature: 1 }]);
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
		const run = nightjar(['--dry-run']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('factory.json: rules: cannot read missing.md');
	}, 30_000);
});

describe('nightjar --once', () => {
	it('builds the oldest Feature assigned to the person with the Go, then exits', () => {
		const { nightjar } = world();
		const run = nightjar(['--once']);
		expect(run.stdout).toContain('nightjar: #1: draft pull request https://github.com/o/r/pull/9');
		expect(run.status).toBe(0);
	}, 30_000);
});

describe('nightjar --dry-run', () => {
	it('names each check it passed, and what it would build', () => {
		const { nightjar, calls } = world();
		const run = nightjar(['--dry-run']);
		expect(run.stdout).toContain(
			`nightjar: checked: no ANTHROPIC_API_KEY, Node ${process.versions.node}, factory.json, gh as ann on o/r, claude 2.1.314 (Claude Code), commits unsigned`
		);
		expect(run.stdout).toContain('nightjar: would build #1 One escape');
		expect(run.status).toBe(0);
		expect(calls()).not.toMatch(/-X (POST|PATCH|DELETE)/);
	}, 30_000);

	it('refuses to start without a factory.json, and says why', () => {
		const { root, nightjar } = world(false);
		const run = nightjar(['--dry-run']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain(`nightjar: no factory.json in ${root}`);
	}, 30_000);
});
