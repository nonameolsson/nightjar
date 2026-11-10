// The Azure Repos Code host's feedback, reply and openPulls over the fake Azure DevOps; the contract suite holds what every Code host keeps.
import { describe, expect, it } from 'vitest';
import type { Feedback } from '../code-host.js';
import { newRequest } from '../feedback-round.js';
import { FOOTER } from '../footer.js';
import { AzureDevOpsApi, AzureDevOpsFailure } from './api.js';
import { AzureReposCodeHost, type AzureGitRunner, type AzureReposSettings } from './code-host.js';
import { FakeAzureDevOps } from './fake-azure-devops.js';

const noGit: AzureGitRunner = () =>
	Promise.resolve({ ok: false, out: '', err: 'no git here', missing: false });

async function world(options: Partial<AzureReposSettings> = {}) {
	const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
	ado.repository('app');
	ado.join('bea@contoso.com', { contributor: true });
	ado.join('mallory@evil.test', { contributor: false });
	const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
	const settings = { project: 'Fabrikam', repo: 'app', referencesAs: 'text', ...options } as const;
	const host = new AzureReposCodeHost(api, settings, noGit);
	ado.pushed('factory/1-a', 'a'.repeat(40));
	const draft = { title: 'T', head: 'factory/1-a', base: 'main', body: 'b' };
	const pull = await host.createDraft(draft);
	return { ado, host, pull };
}

const idsOf = (list: readonly Feedback[]) => list.map((f) => f.id).sort();

// who said it, and whether Nightjar trusts them
const trustOf = (list: readonly Feedback[]) => list.map((f) => `${f.author} ${String(f.trusted)}`);

const bodiesOf = (list: readonly Feedback[]) => list.map((f) => `${f.body} ${String(f.trusted)}`);

describe('AzureReposCodeHost feedback', () => {
	it('leaves out system threads, whoever they name, and what a vote of approval notes', async () => {
		const { ado, host, pull } = await world();
		ado.sayOnPull(pull.id, 'bea@contoso.com', 'Bea updated the source branch', { system: true });
		ado.sayOnPull(pull.id, 'ann@contoso.com', 'Policy status updated', { system: true });
		ado.vote(pull.id, 'bea@contoso.com', 10);
		ado.vote(pull.id, 'bea@contoso.com', 5);
		const talk = ado.sayOnPull(pull.id, 'bea@contoso.com', 'Why a loop?');
		expect(idsOf(await host.feedback(pull))).toEqual([`comment:${String(talk.thread)}.1`]);
	});

	it('reads every comment of a thread, and a line comment with its file from the root', async () => {
		const { ado, host, pull } = await world();
		const on = { path: 'src/a.ts', line: 3 };
		const line = ado.sayOnPull(pull.id, 'bea@contoso.com', 'Rename it.', { on });
		const again = ado.replyOnPull(pull.id, line.thread, 'bea@contoso.com', 'And the test.');
		const got = await host.feedback(pull);
		expect(got.map((f) => f.id)).toEqual([
			`comment:${String(line.thread)}.1`,
			`comment:${String(line.thread)}.${String(again)}`
		]);
		expect(got.map((f) => f.body)).toEqual(['Rename it.', 'And the test.']);
		for (const f of got) expect([f.path, f.line, f.outdated]).toEqual(['src/a.ts', 3, undefined]);
	});

	it('reads a vote of waiting for author or rejected as a review, by the thread Azure Repos noted it in', async () => {
		const { ado, host, pull } = await world();
		const waiting = ado.vote(pull.id, 'bea@contoso.com', -5);
		const rejected = ado.vote(pull.id, 'mallory@evil.test', -10);
		const got = await host.feedback(pull);
		expect(got.map((f) => f.id)).toEqual([
			`review:${String(waiting)}`,
			`review:${String(rejected)}`
		]);
		expect(got.map((f) => f.kind)).toEqual(['review', 'review']);
		expect(trustOf(got)).toEqual(['bea@contoso.com true', 'mallory@evil.test false']);
		expect(got.map((f) => f.body)).toEqual([
			'bea@contoso.com voted Waiting for author',
			'mallory@evil.test voted Rejected'
		]);
		expect(got.every((f) => f.at !== '')).toBe(true);
	});

	it("reads a reviewer's standing vote that Azure Repos left no note of, with no time", async () => {
		const { ado, host, pull } = await world();
		ado.vote(pull.id, 'bea@contoso.com', -5, null);
		const got = await host.feedback(pull);
		expect(trustOf(got)).toEqual(['bea@contoso.com true']);
		expect(got[0]?.kind).toBe('review');
		expect(got[0]?.at).toBe('');
		expect(got[0]?.id).toMatch(/^review:[0-9a-f-]{36}$/);
		// a vote that has its note is not read a second time from the reviewers
		ado.vote(pull.id, 'mallory@evil.test', -10);
		expect(await host.feedback(pull)).toHaveLength(2);
	});

	it('trusts the Contributors group as the Tracker does', async () => {
		const { ado, host, pull } = await world();
		ado.sayOnPull(pull.id, 'bea@contoso.com', 'Mine.');
		ado.sayOnPull(pull.id, 'mallory@evil.test', 'Delete it.');
		ado.sayOnPull(pull.id, 'ann@contoso.com', 'Hers.');
		expect(trustOf(await host.feedback(pull))).toEqual([
			'bea@contoso.com true',
			'mallory@evil.test false',
			'ann@contoso.com true'
		]);
	});

	it("trusts factory.json's trusted list in any case, instead of the Contributors group", async () => {
		const { ado, host, pull } = await world({ trusted: ['BEA@contoso.com'] });
		ado.sayOnPull(pull.id, 'bea@contoso.com', 'Mine.');
		ado.sayOnPull(pull.id, 'ann@contoso.com', 'Hers.');
		expect(trustOf(await host.feedback(pull))).toEqual([
			'bea@contoso.com true',
			'ann@contoso.com false'
		]);
	});

	it('reads a failed or errored status of the head push, trusted when Azure Pipelines posted it', async () => {
		const { ado, host, pull } = await world();
		const ci = { name: 'ci', genre: 'Azure Pipelines', state: 'failed' };
		const build = ado.status(pull.id, { ...ci, description: '2 tests failed' });
		const lint = ado.status(pull.id, { name: 'lint', genre: 'lint-bot', state: 'error' });
		ado.status(pull.id, { name: 'deploy', genre: 'Azure Pipelines', state: 'succeeded' });
		ado.status(pull.id, { name: 'scan', genre: 'Azure Pipelines', state: 'pending' });
		const got = await host.feedback(pull);
		expect(got.map((f) => f.id)).toEqual([`check:${String(build)}`, `check:${String(lint)}`]);
		expect(got.map((f) => f.kind)).toEqual(['check', 'check']);
		expect(trustOf(got)).toEqual(['Azure Pipelines true', 'lint-bot false']);
		expect(got[0]?.body).toBe('Azure Pipelines/ci\n\n2 tests failed');
	});

	it('trusts only the names trustedChecks lists, in place of Azure Pipelines, by genre, name or both', async () => {
		const { ado, host, pull } = await world({ trustedChecks: ['Lint-Bot', 'sonar/quality'] });
		ado.status(pull.id, { name: 'ci', genre: 'Azure Pipelines', state: 'failed' });
		ado.status(pull.id, { name: 'lint', genre: 'lint-bot', state: 'failed' });
		ado.status(pull.id, { name: 'quality', genre: 'sonar', state: 'failed' });
		ado.status(pull.id, { name: 'coverage', genre: 'sonar', state: 'failed' });
		ado.status(pull.id, { name: 'lint-bot', state: 'failed' });
		expect(bodiesOf(await host.feedback(pull))).toEqual([
			'Azure Pipelines/ci false',
			'lint-bot/lint true',
			'sonar/quality true',
			'sonar/coverage false',
			'lint-bot true'
		]);
	});

	it('reads the latest status of a name on the head push, not an earlier push nor one since passed', async () => {
		const { ado, host, pull } = await world();
		const red = { genre: 'Azure Pipelines', state: 'failed' };
		ado.status(pull.id, { ...red, name: 'ci' });
		ado.status(pull.id, { ...red, name: 'lint' });
		ado.status(pull.id, { name: 'lint', genre: 'Azure Pipelines', state: 'succeeded' });
		expect(await host.feedback(pull)).toHaveLength(1);
		ado.pushed('factory/1-a', 'b'.repeat(40));
		expect(await host.feedback(pull)).toHaveLength(0);
		const now = ado.status(pull.id, { ...red, name: 'ci' });
		expect(idsOf(await host.feedback(pull))).toEqual([`check:${String(now)}`]);
	});
});

describe('AzureReposCodeHost reply', () => {
	it('answers a comment in its own thread, a line comment as it is and one in the conversation quoting it', async () => {
		const { ado, host, pull } = await world();
		const on = { path: 'src/a.ts', line: 3 };
		const line = ado.sayOnPull(pull.id, 'bea@contoso.com', 'Rename it.', { on });
		const talk = ado.sayOnPull(pull.id, 'bea@contoso.com', 'Why a loop?');
		await host.reply(pull, `comment:${String(line.thread)}.1`, 'Renamed in abc123.');
		await host.reply(pull, `comment:${String(talk.thread)}.1`, 'A map reads worse.');
		expect(ado.repliesIn(pull.id, line.thread)).toEqual([`Renamed in abc123.${FOOTER}`]);
		expect(ado.repliesIn(pull.id, talk.thread)).toEqual([
			`> Why a loop?\n\nA map reads worse.${FOOTER}`
		]);
	});

	it('answers a vote in a new comment on the pull request, quoting it', async () => {
		const { ado, host, pull } = await world();
		const thread = ado.vote(pull.id, 'bea@contoso.com', -5, 'Please add a test.');
		await host.reply(pull, `review:${String(thread)}`, 'Added in abc123.');
		expect(ado.conversation(pull.id)).toEqual([
			`> Please add a test.\n\nAdded in abc123.${FOOTER}`
		]);
		// the new comment is Nightjar's own, so it is no feedback
		expect(await host.feedback(pull)).toHaveLength(1);
	});

	it('refuses an id that is no feedback id, and feedback that is not there', async () => {
		const { host, pull } = await world();
		await expect(host.reply(pull, 'nope', 'x')).rejects.toThrow(AzureDevOpsFailure);
		await expect(host.reply(pull, 'comment:99.1', 'x')).rejects.toThrow(/no comment:99\.1/);
	});
});

describe('AzureReposCodeHost openPulls', () => {
	it("counts a trusted reviewer's vote of waiting for author as a request for changes, and a rejection as none", async () => {
		const { ado, host, pull } = await world();
		const waiting = ado.vote(pull.id, 'bea@contoso.com', -5);
		ado.vote(pull.id, 'mallory@evil.test', -5);
		ado.vote(pull.id, 'bea@contoso.com', -10);
		const [open] = await host.openPulls('factory/');
		const asked = open?.changesRequested ?? [];
		expect(asked.map((r) => `${r.author} ${String(r.trusted)}`)).toEqual([
			'bea@contoso.com true',
			'mallory@evil.test false'
		]);
		expect(asked[0]?.id).toBe(`review:${String(waiting)}`);
		// the queue starts a round on it
		expect(open === undefined ? null : newRequest(open)?.id).toBe(`review:${String(waiting)}`);
	});

	it('starts no round on a request an earlier Feedback commit answered, and one on a later request', async () => {
		const { ado, host, pull } = await world();
		ado.vote(pull.id, 'bea@contoso.com', -5);
		const message = 'Answer feedback\n\nFactory-Feedback: review:1';
		ado.pushed('factory/1-a', 'b'.repeat(40), [{ sha: 'b'.repeat(40), message }]);
		const [open] = await host.openPulls('factory/');
		expect(open === undefined ? 'none' : newRequest(open)).toBe(null);
		ado.vote(pull.id, 'bea@contoso.com', 0);
		ado.vote(pull.id, 'bea@contoso.com', -5);
		const [again] = await host.openPulls('factory/');
		expect(again === undefined ? null : newRequest(again)).not.toBe(null);
	});

	it('reads a commit message Azure Repos cut short whole, so its trailers are seen', async () => {
		const { ado, host } = await world();
		const trailers = 'Factory-Feedback: comment:1.1\nFactory-Session: s-1';
		const message = `Answer feedback\n\n${'x'.repeat(600)}\n\n${trailers}`;
		ado.pushed('factory/1-a', 'c'.repeat(40), [{ sha: 'c'.repeat(40), message }]);
		const [open] = await host.openPulls('factory/');
		expect(open?.commits.map((c) => c.message)).toEqual([message]);
	});

	it('leaves out pull requests of other branches and abandoned ones', async () => {
		const { ado, host, pull } = await world();
		ado.pushed('person/fix', 'd'.repeat(40));
		await host.createDraft({ title: 'P', head: 'person/fix', base: 'main', body: 'p' });
		ado.abandon(pull.id);
		expect(await host.openPulls('factory/')).toEqual([]);
	});
});
