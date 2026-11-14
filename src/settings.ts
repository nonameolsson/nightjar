// --restricted keeps the person's own settings out, and dontAsk refuses what is not allowed here: nobody is there to approve it.

export const BUILD_TOOLS = [
	'Read',
	'Edit',
	'Write',
	'Glob',
	'Grep',
	'Bash',
	'Skill',
	'Agent',
	'TodoWrite'
];

// The reviewer only reads: no Edit, no Write, and Bash only for git's read commands.
export const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

// Credentials, denied to sandboxed commands and the Read tool alike; the rest of home stays readable for nvm, mise, pyenv or ~/.cargo.
const CREDENTIAL_PATHS = [
	'~/.ssh',
	'~/.aws',
	'~/.azure',
	'~/.config',
	'~/.gnupg',
	'~/.docker',
	'~/.kube',
	'~/.netrc',
	'~/.npmrc',
	'~/.pypirc',
	'~/.git-credentials',
	// another Session's transcripts and the login; Claude Code reads its own outside the sandbox
	'~/.claude*'
];

// Deny wins over any allow in Claude Code, so no config can loosen these.
const DENY = [
	'Bash(git commit *)',
	'Bash(git push *)',
	'Bash(git pull *)',
	'Bash(git fetch *)',
	'Bash(git clone *)',
	'Bash(git reset *)',
	'Bash(git checkout *)',
	'Bash(git switch *)',
	'Bash(git rebase *)',
	'Bash(git merge *)',
	'Bash(git stash *)',
	'Bash(git clean *)',
	'Bash(git branch *)',
	'Bash(git worktree *)',
	'Bash(git remote *)',
	'Bash(git config *)',
	'Bash(gh *)',
	'Bash(curl *)',
	'Bash(wget *)',
	'Bash(ssh *)',
	'Bash(scp *)',
	'Bash(nc *)',
	...CREDENTIAL_PATHS.flatMap((path) => [`Read(${path})`, `Read(${path}/**)`]),
	'WebFetch',
	'WebSearch'
];

const READ_GIT = [
	'Bash(git status)',
	'Bash(git status *)',
	'Bash(git diff)',
	'Bash(git diff *)',
	'Bash(git log *)',
	'Bash(git show *)'
];

// What a Workflow adds for its Steps; the deny rules stay as they are.
export interface StepExtras {
	readonly allowedCommands?: readonly string[];
	readonly allowedTools?: readonly string[];
	readonly localNetwork?: boolean;
}

// Every Session's commands run in it: no network, nothing auto-allowed so the allow list decides, and like DENY no Workflow loosens it.
const SANDBOX = {
	enabled: true,
	// else Claude Code runs commands unsandboxed where the sandbox cannot start
	failIfUnavailable: true,
	// else Claude Code may retry a failed command outside the sandbox
	allowUnsandboxedCommands: false,
	autoAllowBashIfSandboxed: false,
	network: { allowedDomains: [] as string[] },
	// No allowWrite: Claude Code lets a sandboxed command write the worktree and the temp folder, and nothing else.
	filesystem: { denyRead: CREDENTIAL_PATHS }
};

// A localNetwork Step's commands reach localhost and nothing else.
const LOCAL_ONLY = {
	...SANDBOX,
	network: { allowedDomains: ['localhost', '127.0.0.1'], allowLocalBinding: true }
};

// The one place every Session's settings come from; hooks run outside the sandbox, so none run.
const sessionSettings = (permissions: object, sandbox: typeof SANDBOX): object => ({
	permissions,
	sandbox,
	disableAllHooks: true
});

export const stepTools = (extras: StepExtras) => [...BUILD_TOOLS, ...(extras.allowedTools ?? [])];

// `allowed` are factory.json's allowedCommands, as Bash permission patterns.
export function buildSettings(allowed: readonly string[], extras: StepExtras = {}): object {
	return sessionSettings(
		{
			defaultMode: 'dontAsk',
			allow: [
				'Read',
				'Edit',
				'Write',
				'Glob',
				'Grep',
				'Skill',
				'Agent',
				'TodoWrite',
				...(extras.allowedTools ?? []),
				...[...allowed, ...(extras.allowedCommands ?? [])].map((command) => `Bash(${command})`),
				...READ_GIT
			],
			deny: DENY
		},
		extras.localNetwork === true ? LOCAL_ONLY : SANDBOX
	);
}

// Where the Session of a Workflow with `output: "note"` writes its note, from the worktree's root.
export const NOTES_FOLDER = 'docs/research';

// git's read commands take --output, which writes the diff to any file; a note Session may not use it
const NOTE_DENY = 'Bash(git * --output*)';

// A note Workflow's Session writes its note and nothing else: Edit and Write only under NOTES_FOLDER, and Bash only for git's
// read commands, as the repo's allowedCommands can write anywhere. dontAsk refuses every other write; the fixed deny rules stay, with NOTE_DENY beside them.
export function noteSettings(): object {
	return {
		permissions: {
			defaultMode: 'dontAsk',
			allow: [
				'Read',
				'Glob',
				'Grep',
				'TodoWrite',
				`Edit(${NOTES_FOLDER}/**)`,
				`Write(${NOTES_FOLDER}/**)`,
				...READ_GIT
			],
			deny: [...DENY, NOTE_DENY]
		}
	};
}

export function reviewSettings(): object {
	return sessionSettings(
		{
			defaultMode: 'dontAsk',
			allow: ['Read', 'Glob', 'Grep', ...READ_GIT],
			deny: [...DENY, 'Edit', 'Write']
		},
		SANDBOX
	);
}
