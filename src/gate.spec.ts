import { describe, expect, it } from 'vitest';
import { gateReport, type Gate } from './gate.js';

const ESC = '\u001b';
const red = (text: string) => `${ESC}[31m${ESC}[1m${text}${ESC}[22m${ESC}[39m`;

// a stage's whole log, far longer than the tail the check prints
const LOG = [
	` ${red('FAIL')}  src/a.spec.ts > a > opens the dialog`,
	...Array.from({ length: 200 }, (_, i) => `  noise line ${String(i)}`),
	` ${red('FAIL')}  src/b.spec.ts > b > splits the items`,
	` ${red('FAIL')}  src/c.spec.ts > c > walks with j`,
	` ${red('FAIL')}  src/a.spec.ts > a > opens the dialog`
].join('\n');

// a check that prints one line per stage, then the red stage's own tail
const OUTPUT = [
	`types  ${red('green')}  3s`,
	`unit   ${red('red')}  15s`,
	'--- unit (last 150 lines; all of it in .cache/unit.log)',
	'budget: 6.1s of 5.0s  src/slow.spec.ts',
	...Array.from({ length: 80 }, (_, i) => `  tail line ${String(i)}`),
	'---',
	'check: red in 18s'
].join('\n');

const STAGED: Gate = {
	stages: { red: '^(\\S+)\\s+red\\b', log: '.cache/{stage}.log' },
	ignore: '^budget: '
};
const logs: Record<string, string> = { '.cache/unit.log': LOG };
const read = (path: string) => logs[path] ?? null;

describe('gateReport', () => {
	it('names the red stage, and every failing test once from the stage log, before the end of the output', () => {
		const report = gateReport(OUTPUT, STAGED, read);
		expect(report).toContain('Red: unit');
		expect(report).not.toContain('Red: types');
		expect(report).toContain(
			[
				'Failing tests (3):',
				'- src/a.spec.ts > a > opens the dialog',
				'- src/b.spec.ts > b > splits the items',
				'- src/c.spec.ts > c > walks with j'
			].join('\n')
		);
		expect(report.indexOf('Failing tests')).toBeLessThan(report.indexOf('check: red in 18s'));
	});

	it('carries no colour codes, and no line the ignore pattern matches', () => {
		const report = gateReport(OUTPUT, STAGED, read);
		expect(report).not.toContain(ESC);
		expect(report).not.toMatch(/^budget:/m);
	});

	it('ends with the last 40 lines of the output, and says so', () => {
		const report = gateReport(OUTPUT, STAGED, read);
		expect(report).toContain('End of the output (last 40 lines):');
		expect(report).toContain('tail line 79');
		expect(report).not.toContain('tail line 10\n');
	});

	it('finds failing tests in the whole output by default, with no stages configured', () => {
		const output = [
			' FAIL  src/a.spec.ts > one',
			...Array.from({ length: 100 }, (_, i) => `line ${String(i)}`),
			' FAIL  src/b.spec.ts > two',
			' FAIL  src/a.spec.ts > one',
			'done'
		].join('\n');
		const report = gateReport(output, undefined, () => null);
		expect(report).toContain('Failing tests (2):\n- src/a.spec.ts > one\n- src/b.spec.ts > two');
		expect(report).not.toContain('Red:');
	});

	it('takes the test name from the failingTest pattern the repo configures', () => {
		const output = 'not ok 1 - parses\nok 2 - prints\nnot ok 3 - exits';
		const report = gateReport(output, { failingTest: '^not ok \\d+ - (.+)$' }, () => null);
		expect(report).toContain('Failing tests (2):\n- parses\n- exits');
	});

	it('names a red stage it has no test names for, and keeps the tail', () => {
		const output = 'types  red  3s\nunit   green  2s\nsrc/a.ts:3:1 Error: no\ncheck: red in 5s';
		const report = gateReport(output, STAGED, () => null);
		expect(report).toContain('Red: types');
		expect(report).not.toContain('Failing tests');
		expect(report).toContain('src/a.ts:3:1 Error: no');
	});

	it('gives a check with one stage and no pattern the plain tail, without colour codes', () => {
		const output = [
			...Array.from({ length: 100 }, (_, i) => `line ${String(i)}`),
			`${red('error')}: it broke`
		].join('\n');
		const report = gateReport(output, undefined, () => null);
		expect(report).toBe(
			`End of the output (last 40 lines):\n${[
				...Array.from({ length: 39 }, (_, i) => `line ${String(i + 61)}`),
				'error: it broke'
			].join('\n')}`
		);
	});

	it('does not say the output was cut when it fits', () => {
		const report = gateReport('one\ntwo\n', undefined, () => null);
		expect(report).toBe('End of the output:\none\ntwo');
	});
});
