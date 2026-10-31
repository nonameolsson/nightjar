// `nightjar doctor`: runs every check, says how to fix each that fails, and lists what it would build.
import { checkMachine, type CheckOptions, type Line } from './checks.js';
import { dryRun } from './queue.js';

const say = (line: string) => console.log(`nightjar: ${line}`);

const MARKS = { ok: 'ok  ', fail: 'FAIL', skip: 'skip' } as const;

// Failures go to stderr, the rest to stdout; a line that wraps is indented under its name.
export function printLines(lines: readonly Line[]): void {
	for (const line of lines) {
		const text = line.detail.split('\n').join('\n        ');
		const out = `  ${MARKS[line.status]}  ${line.name}: ${text}`;
		if (line.status === 'fail') console.error(out);
		else console.log(out);
	}
}

export const failures = (lines: readonly Line[]) => lines.filter((l) => l.status === 'fail').length;

export async function runDoctor(options: Omit<CheckOptions, 'failFast'>): Promise<number> {
	const checked = await checkMachine({ ...options, failFast: false });
	printLines(checked.lines);
	const failed = failures(checked.lines);
	if (checked.ready === null) {
		const count = failed === 1 ? '1 check' : `${String(failed)} checks`;
		console.error(`nightjar: ${count} failed; fix it, then run \`nightjar doctor\` again.`);
		return 2;
	}
	const { adapters, me } = checked.ready;
	try {
		await dryRun({ tracker: adapters.tracker, person: me, say });
	} catch (fault) {
		console.error(`  FAIL  Features: ${fault instanceof Error ? fault.message : String(fault)}`);
		return 2;
	}
	return 0;
}
