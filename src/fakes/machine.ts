// Stand-ins for gh, az and claude on a PATH that holds nothing else, so no spec reaches the real ones.
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// gh as ann with Feature #1 on o/r; FAKE_GH_EXISTING (comma separated) labels exist; FAKE_GH_SIGNED_OUT fails every call
const GH = String.raw`#!/bin/bash
echo "$*" >> "$FAKE_GH_CALLS"
if [ -n "$FAKE_GH_SIGNED_OUT" ]; then
  echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4
fi
issue='{"number":1,"title":"One escape","body":"","state":"open","labels":[{"name":"factory-go"}],"assignees":[{"login":"ann"}],"user":{"login":"ann"},"sub_issues_summary":{"total":1}}'
case "$*" in
  "api user") echo '{"login":"ann"}' ;;
  "api repos/o/r/issues?"*) echo "[$issue]" ;;
  "api -X POST repos/"*"/labels "*)
    all="$*"; name="@{all#*-f name=}"; name="@{name%% -f*}"
    if [[ ",$FAKE_GH_EXISTING," == *",$name,"* ]]; then
      echo '{"message":"Validation Failed","errors":[{"code":"already_exists"}]}'
      echo "gh: Validation Failed (HTTP 422)" >&2; exit 1
    fi
    if [ -n "$FAKE_GH_NO_LABELS" ]; then echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; fi
    echo '{}' ;;
  "api repos/"*"/labels/"*)
    all="$*"; name="@{all#api repos/*/labels/}"; name="@{name//%20/ }"
    if [[ ",$FAKE_GH_EXISTING," == *",$name,"* ]]; then echo '{}'; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac`;

// az: FAKE_AZ_SIGNED_OUT makes it refuse a token as a signed-out az does
const AZ = String.raw`#!/bin/bash
echo "$*" >> "$FAKE_AZ_CALLS"
if [ -n "$FAKE_AZ_SIGNED_OUT" ]; then
  echo "ERROR: Please run 'az login' to setup account." >&2; exit 1
fi
echo '{"accessToken":"fake-azure-devops"}'`;

// claude: FAKE_CLAUDE_SIGNED_OUT makes `claude auth status` exit 1 as a signed-out claude does;
// a headless session prints its init line with the skills of FAKE_CLAUDE_SKILLS (comma separated)
const CLAUDE = String.raw`#!/bin/bash
echo "$*" >> "$FAKE_CLAUDE_CALLS"
case "$*" in
  "--version") echo "2.1.314 (Claude Code)" ;;
  "auth status")
    if [ -n "$FAKE_CLAUDE_SIGNED_OUT" ]; then echo '{"loggedIn": false}'; exit 1; fi
    echo '{"loggedIn": true}' ;;
  "-p "*)
    skills=""
    if [ -n "$FAKE_CLAUDE_SKILLS" ]; then skills="\"@{FAKE_CLAUDE_SKILLS//,/\",\"}\""; fi
    echo "{\"type\":\"system\",\"subtype\":\"init\",\"apiKeySource\":\"none\",\"skills\":[$skills]}" ;;
esac`;

export type Tool = 'gh' | 'az' | 'claude';

export interface Machine {
	// the checkout, with origin at git@github.com:o/r.git
	readonly root: string;
	readonly env: Record<string, string>;
	// the calls a stand-in was asked, one per line
	calls(tool: Tool): string;
	writeConfig(config: Record<string, unknown>): void;
	readConfig(): unknown;
	remove(): void;
}

// `@{` stands for a shell's own brace expansion, which a template literal cannot hold
function script(dir: string, name: string, body: string) {
	const path = join(dir, name);
	writeFileSync(path, `${body.replaceAll('@{', '$' + '{')}\n`);
	chmodSync(path, 0o755);
}

// `without` leaves a tool off the PATH altogether, as a machine that never installed it.
export function machine(without: readonly Tool[] = []): Machine {
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-machine-')));
	const bin = join(base, 'bin');
	mkdirSync(bin);
	const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
	symlinkSync(realpathSync(git), join(bin, 'git'));
	const tools: Record<Tool, string> = { gh: GH, az: AZ, claude: CLAUDE };
	for (const tool of Object.keys(tools) as Tool[]) {
		if (!without.includes(tool)) script(bin, tool, tools[tool]);
	}
	const gitconfig = join(base, 'gitconfig');
	writeFileSync(gitconfig, '');
	const root = join(base, 'app');
	mkdirSync(root);
	const env: Record<string, string> = {
		PATH: bin,
		HOME: join(base, 'home'),
		TMPDIR: base,
		GIT_CONFIG_GLOBAL: gitconfig,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		FAKE_GH_CALLS: join(base, 'gh-calls.txt'),
		FAKE_AZ_CALLS: join(base, 'az-calls.txt'),
		FAKE_CLAUDE_CALLS: join(base, 'claude-calls.txt')
	};
	for (const calls of [env.FAKE_GH_CALLS, env.FAKE_AZ_CALLS, env.FAKE_CLAUDE_CALLS]) {
		writeFileSync(calls ?? '', '');
	}
	const inRoot = (...args: string[]) =>
		spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
	inRoot('init', '-q', '-b', 'main');
	inRoot('remote', 'add', 'origin', 'git@github.com:o/r.git');
	const file = join(root, 'factory.json');
	return {
		root,
		env,
		calls: (tool) => readFileSync(env[`FAKE_${tool.toUpperCase()}_CALLS`] ?? '', 'utf8'),
		writeConfig: (config) => writeFileSync(file, JSON.stringify(config, null, '\t')),
		readConfig: () => JSON.parse(readFileSync(file, 'utf8')) as unknown,
		remove: () => rmSync(base, { recursive: true, force: true })
	};
}
