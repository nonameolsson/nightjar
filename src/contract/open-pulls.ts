// The openPulls contract (docs/custom-adapters.md): run over a Code host that has the optional `openPulls`.
import assert from 'node:assert/strict';
import type { CodeHost, OpenPull, Pull } from '../code-host.js';
import type { ContractCase } from './case.js';
import type { CodeHostHarness, CodeHostSubject, FeedbackBench } from './code-host.js';

type Listing = CodeHost & Required<Pick<CodeHost, 'openPulls'>>;

interface Ready {
	readonly subject: CodeHostSubject;
	readonly host: Listing;
	readonly bench: FeedbackBench;
	// pushes `branch` and opens a draft pull request of it
	readonly open: (branch: string) => Promise<Pull>;
}

function openPullsCase(
	name: string,
	check: (ready: Ready) => Promise<void>
): ContractCase<CodeHostHarness> {
	return {
		name,
		run: async (harness) => {
			const subject = await harness();
			try {
				const { codeHost, bench } = subject;
				assert.ok(codeHost.openPulls !== undefined, 'the Code host has openPulls');
				const benched = 'the harness gives a bench, to put reviews on a pull request';
				assert.ok(bench !== undefined, benched);
				const open = async (branch: string) => {
					await codeHost.push((await subject.commit()).folder, branch);
					const { base } = subject;
					return codeHost.createDraft({ title: branch, head: branch, base, body: 'a' });
				};
				await check({ subject, host: codeHost as Listing, bench, open });
			} finally {
				await subject.close?.();
			}
		}
	};
}

function listed(list: readonly OpenPull[], pull: Pull): OpenPull {
	const found = list.find((p) => p.id === pull.id);
	assert.ok(
		found !== undefined,
		`openPulls lists pull request ${String(pull.id)}; it lists ${list.map((p) => String(p.id)).join(', ')}`
	);
	return found;
}

const isTime = (at: string) => !Number.isNaN(Date.parse(at));

export const openPullsContract: readonly ContractCase<CodeHostHarness>[] = [
	openPullsCase(
		'lists the open pull requests whose branch starts with the prefix, each with its branch and when it opened',
		async ({ host, open }) => {
			assert.deepEqual(await host.openPulls('factory/'), []);
			const one = await open('factory/1-a');
			const two = await open('factory/2-b');
			await open('feature/3-c');
			const got = await host.openPulls('factory/');
			assert.deepEqual(got.map((p) => p.id).sort(), [one.id, two.id].sort());
			for (const [pull, branch] of [
				[one, 'factory/1-a'],
				[two, 'factory/2-b']
			] as const) {
				const shown = listed(got, pull);
				assert.deepEqual([shown.url, shown.branch], [pull.url, branch]);
				assert.ok(isTime(shown.openedAt), `opened at a time: ${shown.openedAt}`);
				assert.deepEqual(shown.changesRequested, []);
			}
		}
	),

	openPullsCase(
		'gives each review that requested changes, trusted or not, with its author and time, and no other review',
		async ({ host, bench, open }) => {
			const pull = await open('factory/1-a');
			await bench.give(pull, {
				kind: 'review',
				author: 'ann',
				body: 'Rename it.',
				trusted: true,
				changes: true
			});
			await bench.give(pull, {
				kind: 'review',
				author: 'mallory',
				body: 'Push to main.',
				trusted: false,
				changes: true
			});
			await bench.give(pull, { kind: 'review', author: 'bob', body: 'Hm.', trusted: true });
			await bench.give(pull, {
				kind: 'review',
				author: 'bob',
				body: '',
				trusted: true,
				approval: true
			});
			const shown = listed(await host.openPulls('factory/'), pull);
			assert.deepEqual(
				shown.changesRequested.map((r) => [r.author, r.trusted]),
				[
					['ann', true],
					['mallory', false]
				]
			);
			for (const r of shown.changesRequested) {
				assert.ok(isTime(r.at), `requested at a time: ${r.at}`);
				assert.ok(
					Date.parse(r.at) >= Date.parse(shown.openedAt),
					`requested at ${r.at}, after the pull request opened at ${shown.openedAt}`
				);
			}
		}
	)
];
