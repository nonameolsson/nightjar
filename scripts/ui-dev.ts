// `npm run ui:dev [SCENARIO]`: the ui page over made-up .factory/ files in a temp dir, to work on the page without a run.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSpend, record } from '../src/ledger.js';
import { StatusFile } from '../src/status.js';
import { startUi, UI_PORT } from '../src/ui.js';

const SCENARIOS = ['building', 'idle', 'paused', 'stopped', 'off'] as const;
type Scenario = (typeof SCENARIOS)[number];

const arg = process.argv[2] ?? 'building';
if (!SCENARIOS.includes(arg as Scenario)) {
	console.error(`usage: npm run ui:dev [${SCENARIOS.join('|')}]`);
	process.exit(2);
}
const scenario = arg as Scenario;

const root = mkdtempSync(join(tmpdir(), 'nightjar-ui-dev-'));
mkdirSync(join(root, '.factory', 'logs'), { recursive: true });
// placeholder repo names only: scripts/leak-check.ts rejects a real one
writeFileSync(
	join(root, 'factory.json'),
	JSON.stringify({
		tracker: { type: 'github', repo: 'o/app' },
		codeHost: { type: 'github', repo: 'o/app' },
		check: 'npm test',
		allowedCommands: ['npm test']
	})
);

const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const ledger = join(root, '.factory', 'runs.jsonl');
const session = (feature: string, ticket: string | null, minutes: number, costUsd: number) =>
	record(ledger, {
		at: ago(minutes),
		repo: 'o/app',
		feature,
		ticket,
		branch: `nightjar/${feature}`,
		step: ticket === null ? 'review' : 'build',
		session: `s-${feature}-${ticket ?? 'review'}`,
		costUsd,
		outcome: ticket === null ? 'approve' : 'built',
		durationMs: 6 * 60_000
	});

session('268', '1', 95, 1.4);
session('268', '2', 80, 2.1);
session('268', null, 70, 0.6);
session('270', '1', 50, 1.9);

const file = new StatusFile({
	path: join(root, '.factory', 'status.json'),
	spend: fileSpend(ledger),
	now: () => new Date(),
	// a pid that is alive, except in `stopped`
	pid: scenario === 'stopped' ? 2 ** 22 : process.pid,
	dailyUsd: 8,
	watching: scenario === 'idle'
});

file.happened({ kind: 'built', feature: '268', ticket: '1' });
file.happened({
	kind: 'pull',
	feature: '268',
	title: 'Webhook retries',
	url: 'https://github.com/o/app/pull/301',
	startedAt: ago(100),
	tickets: { built: 2, total: 2 }
});
file.happened({
	kind: 'failed',
	feature: '270',
	title: 'Saved filters',
	why: 'the check failed after 3 fix rounds',
	startedAt: ago(55)
});

if (scenario !== 'off') {
	file.refreshed(
		[
			{ id: '275', title: 'Saved filters v2', ticketCounts: { total: 4, closed: 1 } },
			{ id: '281', title: 'CSV <export>', ticketCounts: null },
			{ id: '290', title: 'Reports' }
		],
		{
			items: [
				{ kind: 'feature', id: '262', title: 'Audit log', why: 'needs info' },
				{ kind: 'feature', id: '264', title: 'SSO', why: 'needs a person' }
			],
			trackerCannotList: false
		}
	);
}

if (scenario === 'building' || scenario === 'stopped') {
	const lines = [
		'Reading src/views.ts',
		'Edit src/views.ts',
		'Bash npm test',
		'The list renders; now the share links.'
	].map((text) => ({
		type: 'assistant',
		message: { content: [{ type: 'text', text }] }
	}));
	writeFileSync(
		join(root, '.factory', 'logs', 'dev.jsonl'),
		lines.map((l) => JSON.stringify(l)).join('\n')
	);
	file.doing({
		kind: 'building',
		feature: '272',
		title: 'Custom <views>',
		ticket: '3',
		step: 'build',
		round: 1,
		rounds: 3,
		session: 'dev',
		startedAt: ago(4),
		featureStartedAt: ago(20),
		tickets: [
			{ id: '1', title: 'Models', state: 'built' },
			{ id: '3', title: 'Views list', state: 'building' },
			{ id: '4', title: 'Share links', state: 'waiting', why: 'waits for #3' }
		]
	});
} else if (scenario === 'idle') {
	file.doing({ kind: 'idle', nextPollAt: new Date(now.getTime() + 120_000).toISOString() });
} else if (scenario === 'paused') {
	file.doing({ kind: 'paused', why: 'the day is over $8.00', until: ago(-180) });
} else {
	file.doing({ kind: 'off' });
}

const ui = await startUi({ root, port: Number(process.env.PORT ?? UI_PORT) });
console.log(`${scenario}: http://127.0.0.1:${String(ui.port)}  (Ctrl-C to stop)`);
console.log(`mock .factory/ in ${root}; edit it by hand and the page follows`);

const stop = async () => {
	await ui.close();
	rmSync(root, { recursive: true, force: true });
	process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
