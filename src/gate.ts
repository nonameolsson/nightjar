// What a fix round and the pull request get when the check stays red: the red stages, every failing test once, then the end of the output.
import type { FailedCheck } from './code-host.js';

export interface Gate {
	// a line naming a failing test; its first group is the name
	readonly failingTest?: string;
	// a line that says nothing about why the check is red, dropped from the output
	readonly ignore?: string;
	readonly stages?: {
		// a line naming a red stage; its first group is the stage
		readonly red: string;
		// where the stage's whole log is, relative to the worktree, with {stage} for its name
		readonly log?: string;
	};
}

// matches a FAIL line such as ` FAIL  src/a.spec.ts > a > works`
const DEFAULT_FAILING_TEST = '^\\s*FAIL\\s+(.+?)\\s*$';

const TAIL = 40;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

const plain = (text: string): string => text.replace(ANSI, '');

// The first group of each line the pattern matches, once each, in order.
function firstGroups(lines: readonly string[], pattern: string): string[] {
	const found = new Set<string>();
	const re = new RegExp(pattern);
	for (const line of lines) {
		const name = re.exec(line)?.[1];
		if (name !== undefined) found.add(name);
	}
	return [...found];
}

// `readLog` gives a stage log's text by its path in the worktree, or null when there is none.
// Without a gate it is the plain end of the output; with one, the failing tests too.
export function gateReport(
	output: string,
	gate: Gate | undefined,
	readLog: (path: string) => string | null
): string {
	const ignore = gate?.ignore === undefined ? null : new RegExp(gate.ignore);
	const keep = (lines: string[]) => lines.filter((line) => ignore?.test(line) !== true);
	const lines = keep(plain(output).trimEnd().split('\n'));
	const parts: string[] = [];
	if (gate !== undefined) {
		const failingTest = gate.failingTest ?? DEFAULT_FAILING_TEST;
		const red = gate.stages === undefined ? [] : firstGroups(lines, gate.stages.red);
		const failing = new Set(firstGroups(lines, failingTest));
		const logPath = gate.stages?.log;
		for (const stage of logPath === undefined ? [] : red) {
			const log = readLog((logPath ?? '').replaceAll('{stage}', stage));
			if (log === null) continue;
			for (const name of firstGroups(keep(plain(log).split('\n')), failingTest)) failing.add(name);
		}
		if (red.length > 0) parts.push(`Red: ${red.join(', ')}`);
		if (failing.size > 0) {
			parts.push(
				`Failing tests (${String(failing.size)}):\n${[...failing].map((name) => `- ${name}`).join('\n')}`
			);
		}
	}
	const cut = lines.length > TAIL ? ` (last ${String(TAIL)} lines)` : '';
	parts.push(`End of the output${cut}:\n${lines.slice(-TAIL).join('\n')}`);
	return parts.join('\n\n');
}

// The failed Pull checks in the gate report's shape: the red checks, then each one's job, step and the end of its log.
export function pullChecksReport(failed: readonly FailedCheck[]): string {
	const parts = [`Red: ${failed.map((f) => f.check).join(', ')}`];
	for (const f of failed) {
		const lines = plain(f.logTail).trimEnd().split('\n');
		const cut = lines.length > TAIL ? ` (last ${String(TAIL)} lines)` : '';
		const where = [f.job === '' ? null : `job ${f.job}`, f.step === '' ? null : `step ${f.step}`]
			.filter((w) => w !== null)
			.join(', ');
		parts.push(
			`${f.check}${where === '' ? '' : `: ${where}`}\nEnd of the log${cut}:\n${lines.slice(-TAIL).join('\n')}`
		);
	}
	return parts.join('\n\n');
}
