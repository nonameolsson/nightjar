// What each session may do: the tools it has and the settings it runs on. A session runs
// --restricted, so none of the person's own settings reach it, and anything not allowed here is
// refused (dontAsk), because nobody is there to approve it.

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

// Nightjar's own, and no config can loosen them: deny wins over any allow in Claude Code, so only
// Nightjar commits, pushes, moves the branch and talks to the Tracker and Code host.
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
	'Read(~/.ssh/**)',
	'Read(~/.config/**)',
	'Read(~/.aws/**)',
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

// `allowed` are factory.json's allowedCommands, as Bash permission patterns.
export function buildSettings(allowed: readonly string[]): object {
	return {
		permissions: {
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
				...allowed.map((command) => `Bash(${command})`),
				...READ_GIT
			],
			deny: DENY
		}
	};
}

export function reviewSettings(): object {
	return {
		permissions: {
			defaultMode: 'dontAsk',
			allow: ['Read', 'Glob', 'Grep', ...READ_GIT],
			deny: [...DENY, 'Edit', 'Write']
		}
	};
}
