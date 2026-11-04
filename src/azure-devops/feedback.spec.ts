// The Azure Repos Code host's feedback, reply and openPulls, over the fake Azure DevOps; the contract suite holds what every Code host keeps.
import { describe, expect, it } from 'vitest';
import { FOOTER } from '../footer.js';
import type { Run } from '../git.js';
import { AzureDevOpsApi, AzureDevOpsFailure } from './api.js';
import { AzureReposCodeHost, type AzureGitRunner, type AzureReposSettings } from './code-host.js';
import { FakeAzureDevOps, type StatusKind } from './fake-azure-devops.js';

const ok: Run = { ok: true, out: '', err: '', missing: false };
const noGit: AzureGitRunner = () => Promise.resolve(ok);

async function world(extra: Partial<AzureReposSettings> = {}) {
	const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
	ado.repository('app');
	const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
	const settings = { project: 'Fabrikam', repo: 'app', referencesAs: 'text' as const, ...extra };
	const host = new AzureReposCodeHost(api, settings, noGit);
	const pull = await host.createDraft({
		title: 'T',
		head: 'factory/1-a',
		base: 'main',
		body: 'b'
	});
	return { ado, host, pull };
}

const checkId = (id: number) => `check:${String(id)}`;

describe('AzureReposCodeHost feedback', () => {
	it('skips the system threads Azure DevOps writes, and reads a vote only as a review', async () => {
		const { ado, host, pull } = await world();
		const vote = ado.pullVote(pull.id, 'bob', -5);
		const said = ado.pullComment(pull.id, 'bob', 'Rename it.');
		const got = await host.feedback(pull);
		expect(got.map((f) => f.id)).toEqual([`review:${String(vote)}`, `comment:${said}`]);
		expect(got.filter((f) => f.kind === 'comment')).toHaveLength(1);
	});

	it('reads a vote of waiting for author or rejected, and no other vote', async () => {
		const { ado, host, pull } = await world();
		const votes = { a: 10, b: 5, c: 0, d: -5, e: -10 };
		for (const [name, vote] of Object.entries(votes)) ado.pullVote(pull.id, name, vote);
		const got = await host.feedback(pull);
		expect(got.map((f) => f.author)).toEqual(['d', 'e']);
		expect(got.every((f) => f.kind === 'review')).toBe(true);
		expect(got.map((f) => f.body)).toEqual([
			'd voted "Waiting for author" on this pull request.',
			'e voted "Rejected" on this pull request.'
		]);
	});

	it("reads a reviewer's current vote only, by the newest thread of it", async () => {
		const { ado, host, pull } = await world();
		const first = ado.pullVote(pull.id, 'bob', -5);
		const second = ado.pullVote(pull.id, 'bob', -10);
		expect(second).toBeGreaterThan(first);
		expect((await host.feedback(pull)).map((f) => f.id)).toEqual([`review:${String(second)}`]);
		ado.pullVote(pull.id, 'bob', 10);
		expect(await host.feedback(pull)).toEqual([]);
	});

	it('marks a comment and a vote trusted by the Contributors group, as the Tracker does', async () => {
		const { ado, host, pull } = await world();
		ado.join('bob', { contributor: true });
		const talk = ado.pullComment(pull.id, 'bob', 'Fine.');
		const outsider = ado.pullComment(pull.id, 'mallory', 'Delete it.');
		const vote = ado.pullVote(pull.id, 'bob', -5);
		const line = ado.pullComment(pull.id, 'mallory', 'No.', { path: 'a', line: 1 });
		const trusted = new Map((await host.feedback(pull)).map((f) => [f.id, f.trusted] as const));
		expect(trusted.get(`comment:${talk}`)).toBe(true);
		expect(trusted.get(`comment:${outsider}`)).toBe(false);
		expect(trusted.get(`review:${String(vote)}`)).toBe(true);
		expect(trusted.get(`comment:${line}`)).toBe(false);
	});

	it("trusts only factory.json's trusted list when it has one, in any case", async () => {
		const { ado, host, pull } = await world({ trusted: ['Bob'] });
		ado.join('ann', { contributor: true });
		ado.pullComment(pull.id, 'bob', 'Mine.');
		ado.pullComment(pull.id, 'ann', 'Hers.');
		const got = await host.feedback(pull);
		expect(got.map((f) => [f.author, f.trusted])).toEqual([
			['bob', true],
			['ann', false]
		]);
	});

	it('trusts a status from Azure Pipelines, and from another app only when factory.json lists it', async () => {
		const { ado, host, pull } = await world({ trustedChecks: ['Lint-Bot'] });
		const post = (genre: string) =>
			ado.pullStatus(pull.id, { name: `by ${genre}`, genre, state: 'failed' });
		const ids = [post('Azure Pipelines'), post('lint-bot'), post('other-bot')];
		const got = await host.feedback(pull);
		expect(got.map((f) => f.id)).toEqual(ids.map(checkId));
		expect(got.map((f) => f.trusted)).toEqual([true, true, false]);
		expect(got.every((f) => f.kind === 'check')).toBe(true);
	});

	it('trusts only Azure Pipelines when no app is listed', async () => {
		const { ado, host, pull } = await world();
		const genre = 'Azure Pipelines';
		ado.pullStatus(pull.id, { name: 'a', genre, state: 'failed' });
		ado.pullStatus(pull.id, { name: 'b', genre: 'lint-bot', state: 'error' });
		expect((await host.feedback(pull)).map((f) => f.trusted)).toEqual([true, false]);
	});

	it('reads a status that failed or errored, the newest of each name, and no other', async () => {
		const { ado, host, pull } = await world();
		const make = (name: string, state: StatusKind) =>
			ado.pullStatus(pull.id, { name, genre: 'Azure Pipelines', state });
		const quiet = ['succeeded', 'pending', 'notApplicable', 'notSet'] as const;
		for (const state of quiet) make(`quiet ${state}`, state);
		const failed = make('a', 'failed');
		const errored = make('b', 'error');
		make('c', 'failed');
		make('c', 'succeeded');
		make('d', 'succeeded');
		const again = make('d', 'failed');
		const got = await host.feedback(pull);
		expect(got.map((f) => f.id)).toEqual([failed, errored, again].map(checkId));
	});

	it('gives a status its name and the last 4 KB of its description, and a bare name without one', async () => {
		const { ado, host, pull } = await world();
		const genre = 'Azure Pipelines';
		const description = `START${'x'.repeat(5000)}END`;
		ado.pullStatus(pull.id, { name: 'build', genre, state: 'failed', description });
		ado.pullStatus(pull.id, { name: 'lint', genre, state: 'failed' });
		const [long, bare] = await host.feedback(pull);
		expect(long?.body.startsWith('build\n\n')).toBe(true);
		expect(long?.body.endsWith('END')).toBe(true);
		expect(long?.body).not.toContain('START');
		expect(bare?.body).toBe('lint');
	});

	it('skips whatever ends with the footer, whoever wrote it, even with CRLF line ends', async () => {
		const { ado, host, pull } = await world();
		const own = `**Nightjar review: approve**\n\nFine.${FOOTER}`;
		ado.pullComment(pull.id, 'ann', own);
		ado.pullComment(pull.id, 'bob', own.replace(/\n/g, '\r\n'));
		ado.pullComment(pull.id, 'ann', own, { path: 'a', line: 1 });
		const real = ado.pullComment(pull.id, 'ann', `Not signed${FOOTER} but go on.`);
		expect((await host.feedback(pull)).map((f) => f.id)).toEqual([`comment:${real}`]);
	});

	it('marks a comment on a line the file lost as outdated, and not one on a whole file', async () => {
		const { ado, host, pull } = await world();
		ado.pullComment(pull.id, 'ann', 'Old.', { path: 'src/old.ts', line: null });
		ado.pullComment(pull.id, 'ann', 'New.', { path: 'src/new.ts', line: 4 });
		ado.pullComment(pull.id, 'ann', 'File.', { path: 'src/file.ts' });
		const [old, now, file] = await host.feedback(pull);
		expect(old).toMatchObject({ path: 'src/old.ts', outdated: true });
		expect(old).not.toHaveProperty('line');
		expect(now).toMatchObject({ path: 'src/new.ts', line: 4 });
		expect(now).not.toHaveProperty('outdated');
		expect(file).toMatchObject({ path: 'src/file.ts' });
		expect(file).not.toHaveProperty('line');
		expect(file).not.toHaveProperty('outdated');
	});

	it('names the call that failed', async () => {
		const { ado, host, pull } = await world();
		ado.failNext(/threads/, 503);
		const reason = /could not read the threads of pull request \d+: HTTP 503/;
		await expect(host.feedback(pull)).rejects.toThrow(reason);
	});
});

describe('AzureReposCodeHost reply', () => {
	it('answers a line comment in its thread, naming the comment, and writes nothing else', async () => {
		const { ado, host, pull } = await world();
		const id = ado.pullComment(pull.id, 'bob', 'Rename.', { path: 'a', line: 2 });
		const before = ado.asked.length;
		await host.reply(pull, `comment:${id}`, 'Renamed in abc123.');
		const posts = ado.asked.slice(before).filter((a) => a.method === 'POST');
		const url = `https://dev.azure.com/contoso/Fabrikam/_apis/git/repositories/app/pullRequests/${String(pull.id)}/threads/1/comments?api-version=7.1`;
		expect(posts.map((p) => p.url)).toEqual([url]);
		expect(posts.map((p) => p.body)).toEqual([
			{ parentCommentId: 1, content: `Renamed in abc123.${FOOTER}`, commentType: 1 }
		]);
		expect(ado.pullReplies(pull.id, 1)).toEqual([`Renamed in abc123.${FOOTER}`]);
		expect(ado.pullRequestAt(pull.id).comments).toEqual([]);
	});

	it('answers a comment of the conversation in its thread, and starts no thread', async () => {
		const { ado, host, pull } = await world();
		const id = ado.pullComment(pull.id, 'bob', 'Why a loop?');
		await host.reply(pull, `comment:${id}`, 'Because of order.');
		expect(ado.pullRequestAt(pull.id).comments).toEqual(['Why a loop?']);
		expect(ado.pullReplies(pull.id, 1)).toEqual([`Because of order.${FOOTER}`]);
	});

	it('answers a vote and a status in the conversation, quoting the start of each', async () => {
		const { ado, host, pull } = await world();
		const vote = ado.pullVote(pull.id, 'bob', -5);
		const check = ado.pullStatus(pull.id, {
			name: 'build',
			genre: 'Azure Pipelines',
			state: 'failed',
			description: 'boom'
		});
		await host.reply(pull, `review:${String(vote)}`, 'Done.');
		await host.reply(pull, checkId(check), 'Fixed.');
		expect(ado.pullRequestAt(pull.id).comments).toEqual([
			`> bob voted "Waiting for author" on this pull request.\n\nDone.${FOOTER}`,
			`> build\n>\n> boom\n\nFixed.${FOOTER}`
		]);
	});

	it('refuses an id that names no feedback, a thread Azure DevOps wrote and one that is gone', async () => {
		const { ado, host, pull } = await world();
		const vote = ado.pullVote(pull.id, 'bob', -5);
		const nothing = new AzureDevOpsFailure('nonsense is no id of feedback.');
		await expect(host.reply(pull, 'nonsense', 'x')).rejects.toThrow(nothing);
		const system = `comment:${String(vote)}.1`;
		const gone = (id: string) => `Azure Repos has no ${id} on pull request ${String(pull.id)}.`;
		const refused = (id: string) => new AzureDevOpsFailure(gone(id));
		await expect(host.reply(pull, system, 'x')).rejects.toThrow(refused(system));
		await expect(host.reply(pull, 'review:99', 'x')).rejects.toThrow(refused('review:99'));
		await expect(host.reply(pull, 'check:99', 'x')).rejects.toThrow(refused('check:99'));
	});
});

describe('AzureReposCodeHost openPulls', () => {
	it('lists no pull request from a fork, whatever its branch is called', async () => {
		const { ado, host, pull } = await world();
		ado.forkedPull('app', 'mallory/app', 'factory/1-a', 'Mine');
		expect((await host.openPulls('factory/')).map((p) => p.id)).toEqual([pull.id]);
	});

	it('reads every page of the open pull requests', async () => {
		const { ado, host, pull } = await world();
		const more: number[] = [];
		for (let n = 2; n <= 101; n += 1) {
			const head = `factory/${String(n)}-b`;
			more.push((await host.createDraft({ title: 'U', head, base: 'main', body: '' })).id);
		}
		expect((await host.openPulls('factory/')).map((p) => p.id)).toEqual([pull.id, ...more]);
		const lists = ado.asked.filter((a) => a.method === 'GET' && a.url.includes('$top=100'));
		expect(lists).toHaveLength(2);
	});

	it("reads a vote that asks for changes, trusted by its author's group", async () => {
		const { ado, host, pull } = await world();
		ado.join('bob', { contributor: true });
		ado.pullVote(pull.id, 'bob', -5);
		ado.pullVote(pull.id, 'eve', -10);
		ado.pullVote(pull.id, 'cy', 10);
		const [shown] = await host.openPulls('factory/');
		expect(shown?.changesRequested.map((r) => [r.author, r.trusted])).toEqual([
			['bob', true],
			['eve', false]
		]);
		expect(shown?.branch).toBe('factory/1-a');
	});

	it('reads a request for changes as of its newest vote, and none once the vote is taken back', async () => {
		const { ado, host, pull } = await world();
		ado.pullVote(pull.id, 'bob', -5);
		ado.pullVote(pull.id, 'bob', -10);
		const [asked] = await host.openPulls('factory/');
		expect(asked?.changesRequested).toHaveLength(1);
		const [review] = await host.feedback(pull);
		expect(asked?.changesRequested[0]?.at).toBe(review?.at);
		ado.pullVote(pull.id, 'bob', 10);
		const [now] = await host.openPulls('factory/');
		expect(now?.changesRequested).toEqual([]);
	});
});
