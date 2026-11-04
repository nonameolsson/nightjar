import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const adrs = readdirSync('docs/adr').filter((f) => f.endsWith('.md'));
const number = (file: string) => file.slice(0, 4);

const repoFiles = () =>
	execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
		encoding: 'utf8'
	})
		.split('\0')
		.filter((p) => /\.(md|ts)$/.test(p) && !p.startsWith('.agents/'));

describe('docs/adr', () => {
	it('numbers each ADR once', () => {
		const numbers = adrs.map(number);
		expect(numbers).toEqual([...new Set(numbers)]);
	});

	it('is numbered 0001 upward with no gap', () => {
		expect(adrs.map(number).sort()).toEqual(
			adrs.map((_, i) => String(i + 1).padStart(4, '0')).sort()
		);
	});

	it('is linked, wherever it is named, by a file that exists', () => {
		const dead: string[] = [];
		for (const path of repoFiles()) {
			if (path.startsWith('docs/adr/') || path === 'scripts/adr.spec.ts') continue;
			for (const [, name] of readFileSync(path, 'utf8').matchAll(/adr\/(\d{4}-[\w-]+\.md)/g))
				if (!adrs.includes(name ?? '')) dead.push(`${path}: ${name}`);
		}
		expect(dead).toEqual([]);
	});

	it('is cited by its own number in the revisit-pass paragraph of architecture.md', () => {
		const pullChecks = adrs.find((f) => f.includes('fixes-pull-checks'));
		expect(pullChecks && number(pullChecks)).toBe('0004');
		const line = readFileSync('docs/architecture.md', 'utf8')
			.split('\n')
			.find((l) => l.includes('revisit pass'));
		expect(line).toContain('ADR 0004');
		expect(line).not.toContain('ADR 0003');
	});

	it('records the sandbox as ADR 0005', () => {
		expect(adrs.find((f) => number(f) === '0005')).toMatch(/sandbox/);
	});
});
