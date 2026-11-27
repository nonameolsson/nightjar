import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Modules that predate this check and are covered by another file's spec. Add one only with that reason; give a new module its own spec.
const GRANDFATHERED = new Set([
	'src/adapter-module.ts',
	'src/ask.ts',
	'src/azure-devops/text.ts',
	'src/azure-devops/trust.ts',
	'src/check-output.ts',
	'src/feature-faults.ts',
	'src/feedback-round.ts',
	'src/footer.ts',
	'src/git.ts',
	'src/github/api.ts',
	'src/github/trust.ts',
	'src/log-tail.ts',
	'src/main.ts',
	'src/review-round.ts',
	'src/say.ts',
	'src/signals.ts',
	'src/skills.ts',
	'src/tracker.ts',
	'src/view-text.ts'
]);

// Stand-ins, contract suites (run by each adapter's spec), barrels and fakes are tested through what uses them.
const EXEMPT = /^src\/(fakes|contract)\/|\/index\.ts$|\/fake-[^/]*\.ts$/;

const sources = () =>
	execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src'], {
		encoding: 'utf8'
	})
		.split('\0')
		.filter((p) => p.endsWith('.ts') && !p.endsWith('.spec.ts') && !EXEMPT.test(p));

// A module whose exports are all types has no behaviour of its own to spec.
const hasBehaviour = (path: string) =>
	readFileSync(path, 'utf8')
		.split('\n')
		.some((line) => line.startsWith('export ') && !/^export (type|interface) /.test(line));

describe('specs beside code (CODING_STANDARDS.md)', () => {
	const modules = sources().filter((p) => existsSync(p) && hasBehaviour(p));

	it('gives every module with behaviour its own *.spec.ts', () => {
		const missing = modules.filter(
			(p) => !GRANDFATHERED.has(p) && !existsSync(p.replace(/\.ts$/, '.spec.ts'))
		);
		expect(missing).toEqual([]);
	});

	it('drops a grandfathered module once it has a spec or is gone', () => {
		const stale = [...GRANDFATHERED].filter(
			(p) => !modules.includes(p) || existsSync(p.replace(/\.ts$/, '.spec.ts'))
		);
		expect(stale).toEqual([]);
	});
});
