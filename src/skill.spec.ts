// The shipped skill and the Ticket contract doc show Feature files `nightjar create` takes, and the
// package carries the skill.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFeatureFile } from './feature-file.js';

const PACKAGE = join(import.meta.dirname, '..');
const SKILL = join(PACKAGE, 'skills', 'nightjar-feature', 'SKILL.md');
const CONTRACT = join(PACKAGE, 'docs', 'ticket-contract.md');

// The Markdown blocks a document shows, each whole.
const markdownBlocks = (text: string) =>
	[...text.matchAll(/^```markdown\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? '');

const featureFiles = (path: string) =>
	markdownBlocks(readFileSync(path, 'utf8')).filter((block) => block.startsWith('# '));

describe('the nightjar-feature skill', () => {
	it('ships in the package', () => {
		const pkg = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
			files: string[];
		};
		expect(pkg.files).toContain('skills');
	});

	it('is named as its folder, makes the Feature with nightjar create, and calls on no other skill', () => {
		const text = readFileSync(SKILL, 'utf8');
		expect(text).toMatch(/^---\nname: nightjar-feature\ndescription: \S/);
		expect(text).toContain('npx nightjar create --dry-run');
		expect(text).not.toMatch(/\/[a-z]+-[a-z-]+|Skill tool|invoke the/i);
	});

	it('shows a Feature file the reader takes', () => {
		const [shape] = featureFiles(SKILL);
		expect(shape).toBeDefined();
		const plan = readFeatureFile(shape ?? '');
		expect(plan.tickets.map((t) => t.blockedBy)).toEqual([[], [1]]);
	});
});

describe('docs/ticket-contract.md', () => {
	it('shows a Feature file the reader takes', () => {
		const [example] = featureFiles(CONTRACT);
		const plan = readFeatureFile(example ?? '');
		expect(plan.feature.title).toBe('Share one HTML escape');
		expect(plan.tickets.map((t) => [t.title, t.blockedBy])).toEqual([
			['Move the escape into one module', []],
			['Use it in the comment renderer', [1]]
		]);
	});
});
