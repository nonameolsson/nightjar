// The end of a failed job's log as a Code host's runner writes it, for a Pull check's log tail.

// What a failed job's log keeps; the gate report cuts it further.
const LOG_LINES = 100;

// Each line of a GitHub Actions or Azure Pipelines log starts with its time, such as `2026-11-04T06:53:39.1234567Z `.
const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

const unstamped = (line: string) => line.replace(/\r$/, '').replace(STAMP, '');

export function logTail(log: string): string {
	return log.trimEnd().split('\n').slice(-LOG_LINES).map(unstamped).join('\n');
}
