import { describe, expect, it } from 'vitest';
import { buildSettings, reviewSettings } from './settings.js';

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

describe('reviewSettings', () => {
	it('lets the review only read', () => {
		const deny = permissions(reviewSettings()).deny;
		expect(deny).toEqual(expect.arrayContaining([...FIXED_DENY, 'Edit', 'Write']));
	});

	it('sandboxes the review with no network, as every Session', () => {
		expect(reviewSettings()).toMatchObject({ disableAllHooks: true, sandbox: SEALED });
	});
});
