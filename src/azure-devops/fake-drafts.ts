// What happens to a pull request on the fake Azure DevOps outside Nightjar, as the contract suites and specs play it.
import type { DraftsWorld } from '../contract/code-host.js';
import type { Pull, PullChecks } from '../code-host.js';
import type { FakeAzureDevOps } from './fake-azure-devops.js';

// each line stamped with its time, as Azure Pipelines writes a log
const stamp = (line: string) => `2026-11-04T06:53:39.1234567Z ${line}`;

// Each Pull check as Azure Repos reports it: one with a job as a failed build of a build validation policy, one without as a status.
export function setChecks(ado: FakeAzureDevOps, pull: Pull, checks: PullChecks): void {
	ado.clearChecks(pull.id);
	if (checks.pending) ado.policy(pull.id, { type: 'build', status: 'running' });
	for (const f of checks.failed) {
		if (f.job === '') {
			ado.status(pull.id, { name: f.check, state: 'failed', description: f.logTail });
			continue;
		}
		const log = f.logTail.split('\n').map(stamp).join('\n');
		const buildId = ado.build([
			{
				name: f.job,
				result: 'failed',
				...(f.step === '' ? { log } : {}),
				steps: [
					{ name: 'Checkout', result: 'succeeded', log: stamp('Syncing repository') },
					...(f.step === '' ? [] : [{ name: f.step, result: 'failed', log }])
				]
			}
		]);
		ado.policy(pull.id, { type: 'build', status: 'rejected', displayName: f.check, buildId });
	}
}

export function azureReposDrafts(ado: FakeAzureDevOps): DraftsWorld {
	const done = (act: () => void) => {
		act();
		return Promise.resolve();
	};
	return {
		checks: (pull, checks) => done(() => setChecks(ado, pull, checks)),
		passed: (pull) => done(() => ado.policy(pull.id, { type: 'build', status: 'approved' })),
		engage: (pull) => done(() => ado.sayOnPull(pull.id, 'bea@contoso.com', 'Why this change?')),
		ready: (pull) => done(() => ado.markReady(pull.id)),
		closePull: (pull) => done(() => ado.abandon(pull.id)),
		fork: (pull) => done(() => ado.fork(pull.id))
	};
}
