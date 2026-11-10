// Stand-ins for gh, az, claude, bwrap and socat on a PATH that holds nothing else, so no spec reaches the real ones.
// A stand-in may use shell builtins only: sed, grep, awk and the rest are not on that PATH.
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

// gh for a spec that runs the command as a process, which a Host cannot reach; an in-process spec passes a FakeGitHub
const GH = String.raw`#!/bin/bash
echo "$*" >> "$FAKE_GH_CALLS"
issue() { printf '{"number":%s,"title":"%s","body":"## Acceptance criteria\\n- [ ] It works","state":"open","labels":[{"name":"ready-for-agent"}],"assignees":[{"login":"ann"}],"user":{"login":"ann"}%s}' "$1" "$2" "$3"; }
feature() { printf '{"number":1,"title":"One escape","body":"","state":"open","labels":[{"name":"%s"}],"assignees":[{"login":"%s"}],"user":{"login":"ann"},"sub_issues_summary":{"total":1}}' "@{FAKE_GH_FEATURE_LABEL:-factory-go}" "@{FAKE_GH_FEATURE_ASSIGNEE:-ann}"; }
for a in "$@"; do case "$a" in
  user) echo '{"login":"ann"}'; exit 0 ;;
  repos/o/r/labels) echo '{}'; exit 0 ;;
  repos/o/r/issues\?*) echo "[$(feature)]"; exit 0 ;;
  repos/o/r/issues/1) feature; exit 0 ;;
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

// az: FAKE_AZ_SIGNED_OUT makes it refuse a token as a signed-out az does
const AZ = String.raw`#!/bin/bash
echo "$*" >> "$FAKE_AZ_CALLS"
if [ -n "$FAKE_AZ_SIGNED_OUT" ]; then
  echo "ERROR: Please run 'az login' to setup account." >&2; exit 1
fi
echo '{"accessToken":"fake-azure-devops"}'`;

// The one claude of every spec. FAKE_CLAUDE_SIGNED_OUT makes `claude auth status --json` exit 1 as a signed-out claude
// does, and each call notes the CLAUDE_CONFIG_DIR and CLAUDE_CODE_OAUTH_TOKEN it ran with.
// A headless session prints its init line with the skills of FAKE_CLAUDE_SKILLS (comma separated).
// A session Nightjar starts for a Ticket (it has a session id) writes built.txt, port.txt and login.txt in its
// folder and answers built, at a cost of $0.50; the review session approves. A Feedback round's session (its schema
// asks for a feedbackId) writes answered.txt and answers the first feedback id its prompt names, as do its fix rounds.
const CLAUDE = String.raw`#!/bin/bash
echo "$* [dir=$CLAUDE_CONFIG_DIR token=$CLAUDE_CODE_OAUTH_TOKEN]" >> "$FAKE_CLAUDE_CALLS"
case "$*" in
  "--version") echo "2.1.314 (Claude Code)" ;;
  "auth status --json")
    if [ -n "$FAKE_CLAUDE_SIGNED_OUT" ]; then echo '{"loggedIn": false}'; exit 1; fi
    echo "{\"loggedIn\":true,\"email\":\"ann@x.io\",\"orgName\":\"Acme\",\"subscriptionType\":\"max\",\"authMethod\":\"claude.ai\",\"configDirectory\":\"@{CLAUDE_CONFIG_DIR:-$HOME/.claude}\"}" ;;
  "-p "*)
    skills=""
    if [ -n "$FAKE_CLAUDE_SKILLS" ]; then skills="\"@{FAKE_CLAUDE_SKILLS//,/\",\"}\""; fi
    echo "{\"type\":\"system\",\"subtype\":\"init\",\"apiKeySource\":\"none\",\"skills\":[$skills]}"
    case "$*" in
      *--session-id*|*--resume*)
        case "$*" in
          *feedbackId*)
            echo answered > answered.txt
            id=""
            if [[ "$*" =~ (comment|review|check):[0-9]+ ]]; then id="@{BASH_REMATCH[0]}"; fi
            out="{\"outcome\":\"answered\",\"summary\":\"Answered it.\",\"items\":[{\"feedbackId\":\"$id\",\"answered\":true,\"note\":\"Changed it.\"}],\"blocker\":\"\"}" ;;
          *verdict*) out='{"verdict":"approve","summary":"Reads well.","issues":[]}' ;;
          *)
            echo work > built.txt
            echo "@{WEB_PORT:-none}" > port.txt
            echo "@{CLAUDE_CONFIG_DIR:-none} @{CLAUDE_CODE_OAUTH_TOKEN:-notoken}" > login.txt
            out='{"outcome":"built","summary":"Shared it.","questions":[]}' ;;
        esac
        echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"total_cost_usd\":0.5,\"structured_output\":$out}" ;;
    esac ;;
esac`;

export type Tool = 'gh' | 'az' | 'claude';

export const STAND_INS: Record<Tool, string> = { gh: GH, az: AZ, claude: CLAUDE };

// What Claude Code's sandbox needs on Linux. FAKE_BWRAP_BLOCKED plays a kernel that refuses bwrap a user namespace, as AppArmor does.
export type SandboxTool = 'bwrap' | 'socat';
const SANDBOX_STAND_INS: Record<SandboxTool, string> = {
	bwrap: String.raw`#!/bin/bash
case "$*" in
  *--unshare*)
    if [ -n "$FAKE_BWRAP_BLOCKED" ]; then echo "bwrap: setting up uid map: Permission denied" >&2; exit 1; fi ;;
esac
exit 0`,
	socat: '#!/bin/bash\nexit 0'
};

export interface Machine {
	// the folder that holds the whole machine: its checkout, its home and its stand-ins
	readonly base: string;
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
export function machine(without: readonly (Tool | SandboxTool)[] = []): Machine {
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-machine-')));
	const bin = join(base, 'bin');
	mkdirSync(bin);
	const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
	symlinkSync(realpathSync(git), join(bin, 'git'));
	for (const tool of Object.keys(STAND_INS) as Tool[]) {
		if (!without.includes(tool)) script(bin, tool, STAND_INS[tool]);
	}
	for (const tool of Object.keys(SANDBOX_STAND_INS) as SandboxTool[]) {
		if (!without.includes(tool)) script(bin, tool, SANDBOX_STAND_INS[tool]);
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
		base,
		root,
		env,
		calls: (tool) => readFileSync(env[`FAKE_${tool.toUpperCase()}_CALLS`] ?? '', 'utf8'),
		writeConfig: (config) => writeFileSync(file, JSON.stringify(config, null, '\t')),
		readConfig: () => JSON.parse(readFileSync(file, 'utf8')) as unknown,
		remove: () => rmSync(base, { recursive: true, force: true })
	};
}
