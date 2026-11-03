// What a fix round and the pull request get when the check stays red: the red stages, every failing test once, then the end of the output.
// What names a stage or a test is the repo's own config; nothing here assumes a language or a test runner.

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
export const DEFAULT_FAILING_TEST = '^\\s*FAIL\\s+(.+?)\\s*$';

export const TAIL = 40;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

export const plain = (text: string): string => text.replace(ANSI, '');

// The first group of each line the pattern matches, once each, in order.
function named(lines: readonly string[], pattern: string): string[] {
	const found = new Set<string>();
	const re = new RegExp(pattern);
	for (const line of lines) {
		const name = re.exec(line)?.[1];
		if (name !== undefined) found.add(name);
	}
	return [...found];
}

// `readLog` gives a stage log's text by its path in the worktree, or null when there is none.
export function gateReport(
	output: string,
	gate: Gate | undefined,
	readLog: (path: string) => string | null
): string {
	const ignore = gate?.ignore === undefined ? null : new RegExp(gate.ignore);
	const lines = plain(output)
		.trimEnd()
		.split('\n')
		.filter((line) => ignore?.test(line) !== true);
	const red = gate?.stages === undefined ? [] : named(lines, gate.stages.red);
	const failing = new Set(named(lines, gate?.failingTest ?? DEFAULT_FAILING_TEST));
	const logPath = gate?.stages?.log;
	if (logPath !== undefined) {
		for (const stage of red) {
			const log = readLog(logPath.replaceAll('{stage}', stage));
			if (log === null) continue;
			for (const name of named(plain(log).split('\n'), gate?.failingTest ?? DEFAULT_FAILING_TEST))
				failing.add(name);
		}
	}
	const parts: string[] = [];
	if (gate?.stages !== undefined) {
		parts.push(`Red: ${red.length > 0 ? red.join(', ') : 'no stage named; see the output'}`);
	}
	if (failing.size > 0) {
		parts.push(
			`Failing tests (${String(failing.size)}):\n${[...failing].map((name) => `- ${name}`).join('\n')}`
		);
	}
	const cut = lines.length > TAIL ? ` (last ${String(TAIL)} lines)` : '';
	parts.push(`End of the output${cut}:\n${lines.slice(-TAIL).join('\n')}`);
	return parts.join('\n\n');
}
