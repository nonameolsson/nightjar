import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GUARDED } from './leak-names.js';
import { leaks, packedFiles, repoFiles } from './leak-check.js';

const sha = (word: string) => createHash('sha256').update(word).digest('hex');
const guard = new Set([sha('acmecorp')]);

describe('leaks', () => {
	it('finds a guarded name in a file, in any case and inside a longer text', () => {
		const found = leaks([{ path: 'a.md', text: 'Built for AcmeCorp, with love.' }], guard);
		expect(found).toEqual([{ path: 'a.md', line: 1 }]);
	});

	it('finds one in a path or in a hyphenated name, and says the line, never the word', () => {
		const found = leaks(
			[
				{ path: 'x/acmecorp/y.txt', text: 'fine' },
				{ path: 'b.txt', text: 'ok\nrepo acme-acmecorp-poc' }
			],
			guard
		);
		expect(found).toEqual([
			{ path: 'x/acmecorp/y.txt', line: 0 },
			{ path: 'b.txt', line: 2 }
		]);
		expect(Object.keys(found[1] ?? {})).toEqual(['path', 'line']);
	});

	it('passes a text that names none', () => {
		expect(leaks([{ path: 'a.md', text: 'contoso and fabrikam' }], guard)).toEqual([]);
	});
});

describe('the guard list', () => {
	it('holds hashes only', () => {
		expect(GUARDED.size).toBeGreaterThan(0);
		for (const h of GUARDED) expect(h).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('Nightjar', () => {
	it('names no guarded name in the repo', () => {
		expect(leaks(repoFiles(), GUARDED)).toEqual([]);
	});

	it('names none in any file of the packed package', () => {
		const packed = packedFiles();
		expect(packed.length).toBeGreaterThan(0);
		expect(leaks(packed, GUARDED)).toEqual([]);
	});

	it('ships the plugin and not the guard list', () => {
		const names = packedFiles().map((f) => f.path);
		expect(names).toContain('plugin/nightjar-status/.claude-plugin/plugin.json');
		expect(names).toContain('plugin/nightjar-status/hooks/format.ts');
		expect(names.filter((n) => n.startsWith('scripts/'))).toEqual([]);
	});

	it('the command exits 0 when clean', () => {
		execFileSync('npx', ['tsx', 'scripts/leak-check.ts'], { cwd: process.cwd(), stdio: 'pipe' });
	});
});
