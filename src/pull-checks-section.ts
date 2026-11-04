// The Pull checks section of a pull request body: one block per Pull-check fix round, added to it every round.
import type { FailedCheck } from './code-host.js';
import { failedAt } from './gate.js';

// What one Pull-check fix round did, as the section tells it.
export interface PullRound {
	readonly round: number;
	// a fix pushed to the branch, or a round that gave up with nothing pushed
	readonly outcome: 'pushed' | 'gave up';
	// the Session's summary of the fix, or why the round gave up
	readonly summary: string;
	// the Pull checks that were red when the round began
	readonly failed: readonly FailedCheck[];
	readonly usd: number;
}

const START = '<!-- nightjar-pull-checks-section -->';
const END = '<!-- /nightjar-pull-checks-section -->';
const SECTION = new RegExp(`${START}\\n## Pull checks\\n\\n([\\s\\S]*?)\\n${END}`);

// One failed Pull check as a line of a list: the check, then where it failed.
export function failingLine(f: FailedCheck): string {
	const where = failedAt(f);
	return `- \`${f.check}\`${where === '' ? '' : `: ${where}`}`;
}

function block(r: PullRound): string {
	// a summary may not close the section early
	const summary = r.summary.trim().replaceAll('<!--', '<!- -');
	return `### Round ${String(r.round)}: ${r.outcome}, $${r.usd.toFixed(2)}\n\n${summary}\n\nFailing Pull checks:\n\n${r.failed.map(failingLine).join('\n')}`;
}

// The body with `round` added to its Pull checks section, which is made before the Cost section when the body has none yet.
export function withPullRound(body: string, round: PullRound): string {
	const earlier = SECTION.exec(body)?.[1];
	const rounds = [...(earlier === undefined ? [] : [earlier]), block(round)];
	const section = `${START}\n## Pull checks\n\n${rounds.join('\n\n')}\n${END}`;
	if (earlier !== undefined) return body.replace(SECTION, () => section);
	const cost = body.indexOf('## Cost');
	return cost < 0
		? `${body}\n\n${section}`
		: `${body.slice(0, cost)}${section}\n\n${body.slice(cost)}`;
}
