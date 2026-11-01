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
});

describe('reviewSettings', () => {
	it('lets the review only read', () => {
		const deny = permissions(reviewSettings()).deny;
		expect(deny).toEqual(expect.arrayContaining([...FIXED_DENY, 'Edit', 'Write']));
	});
});
