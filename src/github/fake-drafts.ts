// What happens to a pull request on the fake GitHub outside Nightjar, as the contract suites and specs play it.
import type { DraftsWorld } from '../contract/code-host.js';
import type { Pull, PullChecks } from '../code-host.js';
import type { FakeGitHub } from './fake-github.js';

// each line stamped with its time, as GitHub writes an Actions log
const stamp = (line: string) => `2026-11-04T06:53:39.1234567Z ${line}`;

// Each Pull check as GitHub reports it: one with a job as an Actions job of its workflow (`CI / test` is workflow CI, job test), one without as a commit status.
export function setChecks(github: FakeGitHub, pull: Pull, checks: PullChecks): void {
	const head = github.headOf(pull.id);
	github.clearChecks(head);
	if (checks.pending) github.checkRun(head, { name: 'lint', status: 'in_progress' });
	for (const f of checks.failed) {
		if (f.job === '') {
			github.commitStatus(head, { context: f.check, state: 'failure', description: f.logTail });
			continue;
		}
		const suffix = ` / ${f.job}`;
		github.actionsJob(head, {
			workflow: f.check.endsWith(suffix) ? f.check.slice(0, -suffix.length) : f.check,
			name: f.job,
			conclusion: 'failure',
			steps: [
				{ name: 'Set up job', conclusion: 'success' },
				...(f.step === '' ? [] : [{ name: f.step, conclusion: 'failure' }])
			],
			log: f.logTail.split('\n').map(stamp).join('\n')
		});
	}
}

export function gitHubDrafts(github: FakeGitHub): DraftsWorld {
	const done = (act: () => void) => {
		act();
		return Promise.resolve();
	};
	return {
		checks: (pull, checks) => done(() => setChecks(github, pull, checks)),
		passed: (pull) =>
			done(() => {
				github.checkRun(github.headOf(pull.id), { name: 'lint', conclusion: 'success' });
			}),
		engage: (pull) => done(() => github.say(pull.id, 'bea', 'Why this change?')),
		ready: (pull) => done(() => github.markReady(pull.id)),
		closePull: (pull) => done(() => github.close(pull.id)),
		fork: (pull) => done(() => github.fork(pull.id))
	};
}
