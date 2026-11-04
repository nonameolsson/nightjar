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

	it('keeps the deny rules as they are and refuses anything not allowed', () => {
		expect(permissions(noteSettings()).deny).toEqual(permissions(buildSettings([])).deny);
		expect(noteSettings()).toMatchObject({ permissions: { defaultMode: 'dontAsk' } });
	});
});

describe('reviewSettings', () => {
	it('lets the review only read', () => {
		const deny = permissions(reviewSettings()).deny;
		expect(deny).toEqual(expect.arrayContaining([...FIXED_DENY, 'Edit', 'Write']));
	});
});
