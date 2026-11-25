// What a view says of one Logbook decision: one line, and what it folds beneath it. Plain text; a Signal's name and a command sit in backticks, which the page sets as code.
import type { LogbookEntry } from './logbook.js';
import type { SignalNames } from './signals.js';

export interface DecisionText {
	// what happened, in one line
	readonly line: string;
	// what the view folds beneath the line until it is opened: its label, and the text it holds
	readonly more?: { readonly label: string; readonly text: string };
}

const count = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

const VERDICT = {
	done: 'done',
	unmet: 'ran every round with its condition unmet',
	undone: 'not done'
} as const;

const FEEDBACK_END = {
	answered: 'answered',
	thrownAway: 'thrown away',
	paused: 'paused',
	stopped: 'stopped'
} as const;

const PULL_FIX_END = {
	pushed: 'pushed a fix',
	gaveUp: 'gave up',
	paused: 'paused',
	stopped: 'stopped',
	diverged: 'set its fix aside'
} as const;

const why = (text: string | undefined) => (text === undefined || text === '' ? '' : `: ${text}`);

export function decisionText(entry: LogbookEntry, signals: SignalNames): DecisionText {
	switch (entry.kind) {
		case 'buildStarted': {
			const by =
				entry.by === 'go'
					? 'by the Go'
					: `by a request for changes${entry.asked === undefined ? '' : ` (${entry.asked})`}`;
			const workflow = entry.workflow === null ? '' : `, Workflow ${entry.workflow}`;
			return { line: `Build started ${by} on ${entry.branch}${workflow}` };
		}
		case 'setup':
			return { line: `Setup \`${entry.command}\` ${entry.ok ? 'ran' : 'failed'}` };
		case 'ticketStarted':
			return { line: 'Ticket started' };
		case 'ticketBuilt':
			return { line: `Ticket built in commit ${entry.commit}` };
		case 'checkRed':
			return {
				line: `Check red, so fix round ${String(entry.round)} of ${String(entry.rounds)}`,
				more: { label: 'Gate report', text: entry.report }
			};
		case 'thrownAway':
			return {
				line: `${entry.branch === null ? 'Thrown away, leaving nothing' : `Thrown away onto ${entry.branch}`}${why(entry.why)}`
			};
		case 'stepVerdict': {
			const rounds = entry.rounds === undefined ? '' : ` after ${count(entry.rounds, 'round')}`;
			const line = `Step ${entry.step} of Workflow ${entry.workflow}: ${VERDICT[entry.verdict]}${rounds}${why(entry.why)}`;
			return entry.left.length === 0
				? { line }
				: { line, more: { label: 'Left', text: entry.left.join('\n') } };
		}
		case 'review': {
			const verdict =
				entry.verdict === 'approve'
					? 'Review approved'
					: entry.verdict === 'changes'
						? 'Review asked for changes'
						: 'Review did not finish';
			const line = `${verdict}${why(entry.summary ?? undefined)}`;
			if (entry.issues.length === 0) return { line };
			const issues = entry.issues
				.map((i) => `${i.file}${i.line === undefined ? '' : `:${String(i.line)}`} ${i.problem}`)
				.join('\n');
			return { line, more: { label: count(entry.issues.length, 'issue'), text: issues } };
		}
		case 'signal':
			return {
				line: `Signal \`${signals[entry.signal]}\` ${entry.on ? 'put on' : 'taken off'}`
			};
		case 'pullOpened':
			return {
				line: `${entry.created ? 'Draft pull request opened' : 'Draft pull request updated'}: ${entry.url}`
			};
		case 'paused':
			return { line: `Paused${why(entry.why)}` };
		case 'feedbackRound': {
			const commit = entry.commit === undefined ? '' : ` in commit ${entry.commit}`;
			const line = `Feedback round ${FEEDBACK_END[entry.end]}${commit}${why(entry.why)}: ${String(entry.answered.length)} answered, ${String(entry.left.length)} left`;
			const text = [
				...entry.answered.map((id) => `answered ${id}`),
				...entry.left.map((l) => `left ${l.id}: ${l.why}`)
			].join('\n');
			return text === '' ? { line } : { line, more: { label: 'Feedback', text } };
		}
		case 'pullFix': {
			const line = `Pull-check fix round ${String(entry.round)} of ${String(entry.rounds)} ${PULL_FIX_END[entry.end]}${why(entry.why)}`;
			const text = entry.failing
				.map((f) => [f.check, f.job, f.step].filter((s) => s !== '').join(' / '))
				.join('\n');
			return text === ''
				? { line }
				: { line, more: { label: count(entry.failing.length, 'failing Pull check'), text } };
		}
		case 'madeBySource':
			return {
				line: `Made by the Source ${entry.source}${entry.key === undefined ? '' : ` for ${entry.key}`}`
			};
		case 'happenedAgain':
			return {
				line: `The Source ${entry.source} said it happened again (${count(entry.times, 'time')})`
			};
		case 'standingGo':
			return {
				line: `The Source ${entry.source} gave the standing Go and assigned it to ${entry.owner}`
			};
		case 'handed':
			return {
				line: `Handed to a person with \`${signals[entry.to]}\`${why(entry.why)}`
			};
	}
}
