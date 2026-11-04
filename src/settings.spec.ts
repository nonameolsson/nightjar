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
