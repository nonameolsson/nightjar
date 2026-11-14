import { describe, expect, it } from 'vitest';
import { NOTES_FOLDER, buildSettings, noteSettings, reviewSettings } from './settings.js';

interface Permissions {
	readonly permissions: { readonly allow: string[]; readonly deny: string[] };
}
const permissions = (s: object) => (s as Permissions).permissions;

const FIXED_DENY = [
	'Bash(git commit *)',
	'Bash(git push *)',
	'Bash(git checkout *)',
	'Bash(git switch *)',
	'Bash(gh *)',
	'Bash(curl *)',
	'WebFetch',
	'WebSearch'
];

// the sandbox of a Session with no network: on, auto-allowing nothing, and never run around
const SEALED = {
	enabled: true,
	failIfUnavailable: true,
	allowUnsandboxedCommands: false,
	autoAllowBashIfSandboxed: false,
	network: { allowedDomains: [] }
};

// every path whose contents are a credential, kept out of the sandbox and out of the Read tool
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
	'~/.claude*'
];

// each kind of Session, the one place its settings come from
const everySession: [string, object][] = [
	['a build Session', buildSettings([])],
	['a Step with a local network', buildSettings([], { localNetwork: true })],
	[
		'a Step with extras',
		buildSettings(['make test'], { allowedCommands: ['npm install'], allowedTools: ['mcp__pw'] })
	],
	['the review', reviewSettings()]
];

interface Sandbox {
	readonly sandbox: { readonly filesystem?: { readonly denyRead?: string[] } };
}

describe.each(everySession)('credential paths in %s', (_name, settings) => {
	it('cannot be read by a sandboxed command', () => {
		expect((settings as Sandbox).sandbox.filesystem?.denyRead).toEqual(
			expect.arrayContaining(CREDENTIAL_PATHS)
		);
	});

	it('cannot be read by the Read tool, itself or below it', () => {
		const deny = permissions(settings).deny;
		for (const path of CREDENTIAL_PATHS) {
			expect(deny).toEqual(expect.arrayContaining([`Read(${path})`, `Read(${path}/**)`]));
		}
	});

	it('keeps the rest of the home folder readable, so toolchains under it still run', () => {
		const denied = (settings as Sandbox).sandbox.filesystem?.denyRead ?? [];
		for (const toolchain of ['~', '~/.nvm', '~/.cargo', '~/.pyenv', '~/.local/share/mise']) {
			expect(denied).not.toContain(toolchain);
		}
		expect(permissions(settings).deny).not.toContain('Read');
	});

	it('are not listed again for a write: a Session writes the worktree and the temp folder only', () => {
		const text = JSON.stringify(settings);
		expect(text).not.toContain('allowWrite');
		expect(text).not.toContain('additionalDirectories');
	});
});

describe('the deny rules only grow', () => {
	it('keeps the Read rules the first sandbox shipped with', () => {
		expect(permissions(buildSettings([])).deny).toEqual(
			expect.arrayContaining(['Read(~/.ssh/**)', 'Read(~/.config/**)', 'Read(~/.aws/**)'])
		);
	});

	it('gives the review everything the build denies, and more', () => {
		expect(permissions(reviewSettings()).deny).toEqual(
			expect.arrayContaining(permissions(buildSettings([])).deny)
		);
	});
});

describe('buildSettings', () => {
	it('allows the configured commands in Bash', () => {
		expect(permissions(buildSettings(['make test', 'cargo build *'])).allow).toEqual(
			expect.arrayContaining(['Bash(make test)', 'Bash(cargo build *)'])
		);
	});

	it('keeps every deny rule, whatever the allowed commands say', () => {
		const loosened = buildSettings(['git push *', 'gh *', 'git commit *', 'curl *']);
		expect(permissions(loosened).deny).toEqual(expect.arrayContaining(FIXED_DENY));
		expect(permissions(buildSettings([])).deny).toEqual(permissions(loosened).deny);
	});

	it('refuses anything not allowed, as nobody is there to approve it', () => {
		expect(buildSettings([])).toMatchObject({ permissions: { defaultMode: 'dontAsk' } });
	});

	it('sandboxes every Session with no network, failing closed and running no hooks', () => {
		for (const settings of [buildSettings([]), buildSettings([], { localNetwork: false })]) {
			expect(settings).toMatchObject({ disableAllHooks: true, sandbox: SEALED });
		}
	});

	it('lets no Workflow extra open the network or turn the sandbox off', () => {
		const settings = buildSettings(['curl *'], {
			allowedCommands: ['npm install', 'curl *'],
			allowedTools: ['WebFetch', 'mcp__pw']
		});
		expect(settings).toMatchObject({ disableAllHooks: true, sandbox: SEALED });
	});

	it('fails closed under localNetwork: no Step runs unsandboxed, by start or by retry', () => {
		expect(buildSettings([], { localNetwork: true })).toMatchObject({
			disableAllHooks: true,
			sandbox: {
				...SEALED,
				network: { allowedDomains: ['localhost', '127.0.0.1'] }
			}
		});
	});
});

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// A rule's pattern as a regex: in a path, `**` is any folders and `*` stays within one; in a command, `*` is anything.
const patternOf = (pattern: string, path: boolean) =>
	new RegExp(
		`^${pattern
			.split('**')
			.map((part) =>
				part
					.split('*')
					.map(escape)
					.join(path ? '[^/]*' : '.*')
			)
			.join('.*')}$`
	);

// Claude Code's call on one tool use under dontAsk: a deny rule wins, then an allow rule, and the rest is refused.
// `target` is the file, from the worktree's root, or the Bash command.
function decide(settings: object, tool: string, target: string): 'allowed' | 'refused' {
	const { allow, deny } = permissions(settings);
	const matches = (rule: string) => {
		const m = /^(\w+)(?:\((.*)\))?$/.exec(rule);
		if (m?.[1] !== tool) return false;
		return m[2] === undefined || patternOf(m[2], tool !== 'Bash').test(target);
	};
	if (deny.some(matches)) return 'refused';
	return allow.some(matches) ? 'allowed' : 'refused';
}

describe('noteSettings', () => {
	it('refuses a Session that tries to write src/x.ts, which a build Session may', () => {
		const note = noteSettings();
		expect(decide(note, 'Write', 'src/x.ts')).toBe('refused');
		expect(decide(note, 'Edit', 'src/x.ts')).toBe('refused');
		expect(decide(buildSettings([]), 'Write', 'src/x.ts')).toBe('allowed');
	});

	it(`lets it write and edit only under ${NOTES_FOLDER}/`, () => {
		const note = noteSettings();
		expect(decide(note, 'Write', 'docs/research/203-why.md')).toBe('allowed');
		expect(decide(note, 'Edit', 'docs/research/deep/a.md')).toBe('allowed');
		expect(decide(note, 'Write', 'docs/x.md')).toBe('refused');
		expect(decide(note, 'Write', 'docs/research-x/a.md')).toBe('refused');
		expect(decide(note, 'Read', 'src/x.ts')).toBe('allowed');
	});

	it("runs none of the repo's commands, as they can write anywhere, and only git's read commands", () => {
		const note = noteSettings();
		expect(decide(note, 'Bash', 'npm run format')).toBe('refused');
		expect(decide(note, 'Bash', 'git log --oneline')).toBe('allowed');
		expect(decide(note, 'Bash', 'git commit -m x')).toBe('refused');
	});

	it("refuses git's read commands that write a file, as --output does", () => {
		const note = noteSettings();
		expect(decide(note, 'Bash', 'git diff HEAD~1')).toBe('allowed');
		expect(decide(note, 'Bash', 'git diff --output=src/x.ts')).toBe('refused');
		expect(decide(note, 'Bash', 'git log --output src/x.ts')).toBe('refused');
		expect(decide(note, 'Bash', 'git show --stat --output=src/x.ts HEAD')).toBe('refused');
	});

	it('brings no skill or subagent, whose own tools the write limit does not cover', () => {
		const note = noteSettings();
		expect(decide(note, 'Skill', 'any')).toBe('refused');
		expect(decide(note, 'Agent', 'any')).toBe('refused');
	});

	it('keeps every deny rule the build has and refuses anything not allowed', () => {
		expect(permissions(noteSettings()).deny).toEqual(
			expect.arrayContaining(permissions(buildSettings([])).deny)
		);
		expect(noteSettings()).toMatchObject({ permissions: { defaultMode: 'dontAsk' } });
	});
});

describe('reviewSettings', () => {
	it('lets the review only read', () => {
		const deny = permissions(reviewSettings()).deny;
		expect(deny).toEqual(expect.arrayContaining([...FIXED_DENY, 'Edit', 'Write']));
	});

	it('sandboxes the review with no network, as every Session', () => {
		expect(reviewSettings()).toMatchObject({ disableAllHooks: true, sandbox: SEALED });
	});
});
