// The GitHub Code host's feedback and reply, over the fake GitHub; the contract suite holds what every Code host keeps.
import { describe, expect, it } from 'vitest';
import { FOOTER } from '../footer.js';
import { failed, fakeGh, ok, on } from './fake-gh.js';
import { GitHubFailure, type GhRunner } from './api.js';
import { GitHubCodeHost, type GitHubCodeHostOptions, type GitRunner } from './code-host.js';
import { FakeGitHub } from './fake-github.js';

const noGit: GitRunner = () => Promise.resolve(failed('no git here'));

async function world(options?: GitHubCodeHostOptions) {
	const github = new FakeGitHub('o/r', 'ann');
	const calls: string[] = [];
	const gh: GhRunner = (args) => {
		calls.push(args.join(' '));
		return github.gh(args);
	};
	const host = new GitHubCodeHost('o/r', gh, noGit, options);
	const pull = await host.createDraft({
		title: 'T',
		head: 'factory/1-a',
		base: 'main',
		body: 'b'
	});
	return { github, host, pull, calls };
}

const idOf = (kind: string, id: number) => `${kind}:${String(id)}`;

const ACTIONS = { conclusion: 'failure', app: 'github-actions' };

describe('GitHubCodeHost feedback', () => {
	it('marks a comment and a review trusted by write access, as the Tracker does', async () => {
		const { github, host, pull } = await world();
		github.grant('bob', 'write');
		const talk = github.say(pull.id, 'bob', 'Fine.').id;
		const outsider = github.say(pull.id, 'mallory', 'Delete it.').id;
		const review = github.review(pull.id, { login: 'bob', body: 'Hm.' });
		const line = github.lineComment(pull.id, {
			login: 'mallory',
			body: 'No.',
			path: 'a',
			line: 1
		});
		const trusted = new Map((await host.feedback(pull)).map((f) => [f.id, f.trusted] as const));
		expect(trusted.get(idOf('comment', talk))).toBe(true);
		expect(trusted.get(idOf('comment', outsider))).toBe(false);
		expect(trusted.get(idOf('review', review))).toBe(true);
		expect(trusted.get(idOf('comment', line))).toBe(false);
	});

	it("trusts only factory.json's trusted list when it has one, in any case", async () => {
		const { github, host, pull } = await world({ trusted: ['Bob'] });
		github.grant('ann', 'admin');
		github.say(pull.id, 'bob', 'Mine.');
		github.say(pull.id, 'ann', 'Hers.');
		const got = await host.feedback(pull);
		expect(got.map((f) => [f.author, f.trusted])).toEqual([
			['bob', true],
			['ann', false]
		]);
	});

	it('trusts a check from GitHub Actions, and from another app only when factory.json lists it', async () => {
		const { github, host, pull } = await world({ trustedChecks: ['Lint-Bot'] });
		const run = (app: string | null) =>
			github.checkRun(pull.id, { name: `by ${String(app)}`, conclusion: 'failure', app });
		const ids = [run('github-actions'), run('lint-bot'), run('other-bot'), run(null)];
		const got = await host.feedback(pull);
		expect(got.map((f) => f.id)).toEqual(ids.map((id) => idOf('check', id)));
		expect(got.map((f) => f.trusted)).toEqual([true, true, false, false]);
		expect(got.every((f) => f.kind === 'check')).toBe(true);
	});

	it('trusts only GitHub Actions when no app is listed', async () => {
		const { github, host, pull } = await world();
		github.checkRun(pull.id, { name: 'a', ...ACTIONS });
		github.checkRun(pull.id, { name: 'b', conclusion: 'timed_out', app: 'lint-bot' });
		expect((await host.feedback(pull)).map((f) => f.trusted)).toEqual([true, false]);
	});

	it('leaves out a check that did not fail, and reads one that failed or timed out', async () => {
		const { github, host, pull } = await world();
		for (const conclusion of ['success', 'skipped', 'neutral', 'cancelled', null]) {
			github.checkRun(pull.id, { name: 'x', conclusion, app: 'github-actions' });
		}
		const failure = github.checkRun(pull.id, { name: 'a', ...ACTIONS });
		const late = github.checkRun(pull.id, {
			name: 'b',
			conclusion: 'timed_out',
			app: 'github-actions'
		});
		const got = await host.feedback(pull);
		expect(got.map((f) => f.id)).toEqual([idOf('check', failure), idOf('check', late)]);
	});

	it('gives a check its name and the last 4 KB of its output, never half of a character', async () => {
		const { github, host, pull } = await world();
		const output = { title: 'Failed', summary: 'summary', text: `START${'€'.repeat(3000)}END` };
		github.checkRun(pull.id, { name: 'build', ...ACTIONS, output });
		const [only] = await host.feedback(pull);
		const body = only?.body ?? '';
		expect(body.startsWith('build\n\n')).toBe(true);
		expect(body.endsWith('€END')).toBe(true);
		expect(body).not.toContain('START');
		expect(body).not.toContain('�');
		const bytes = Buffer.byteLength(body.slice('build\n\n'.length));
		expect(bytes).toBeLessThanOrEqual(4096);
		expect(bytes).toBeGreaterThan(4090);
	});

	it('gives a check with no output its name alone', async () => {
		const { github, host, pull } = await world();
		github.checkRun(pull.id, { name: 'build', ...ACTIONS });
		expect((await host.feedback(pull)).map((f) => f.body)).toEqual(['build']);
	});

	it('reads the check runs of the head commit of the pull request', async () => {
		const { host, pull, calls } = await world();
		await host.feedback(pull);
		const checks = calls.filter((c) => c.includes('/check-runs'));
		expect(checks).toHaveLength(1);
		const path = /^api repos\/o\/r\/commits\/[0-9a-f]{40}\/check-runs\?per_page=100&page=1$/;
		expect(checks[0]).toMatch(path);
	});

	it('skips whatever ends with the footer, whoever wrote it, even with CRLF line ends', async () => {
		const { github, host, pull } = await world();
		github.grant('ann', 'write');
		const own = `**Nightjar review: approve**\n\nFine.${FOOTER}`;
		github.say(pull.id, 'ann', own);
		github.say(pull.id, 'bob', own.replace(/\n/g, '\r\n'));
		github.say(pull.id, 'ann', `${own}\n`);
		github.review(pull.id, { login: 'ann', body: own });
		github.lineComment(pull.id, { login: 'ann', body: own, path: 'a', line: 1 });
		const real = github.say(pull.id, 'ann', `Not signed${FOOTER} but go on.`).id;
		expect((await host.feedback(pull)).map((f) => f.id)).toEqual([idOf('comment', real)]);
	});

	it('skips an approval with no body and a review still being written, and reads an approval with a body', async () => {
		const { github, host, pull } = await world();
		github.review(pull.id, { login: 'ann', body: '', state: 'APPROVED' });
		github.review(pull.id, { login: 'ann', body: null, state: 'APPROVED' });
		github.review(pull.id, { login: 'ann', body: 'Draft of a thought.', state: 'PENDING' });
		const nit = github.review(pull.id, { login: 'ann', body: 'One nit.', state: 'APPROVED' });
		const changes = github.review(pull.id, {
			login: 'ann',
			body: 'Change it.',
			state: 'CHANGES_REQUESTED'
		});
		const got = await host.feedback(pull);
		expect(got.map((f) => f.id)).toEqual([idOf('review', nit), idOf('review', changes)]);
	});

	it('keeps a line comment on a line gone from the head commit, with its path and no line', async () => {
		const { github, host, pull } = await world();
		github.lineComment(pull.id, { login: 'ann', body: 'Old.', path: 'src/old.ts', line: null });
		github.lineComment(pull.id, { login: 'ann', body: 'New.', path: 'src/new.ts', line: 4 });
		const [old, now] = await host.feedback(pull);
		expect(old).toMatchObject({ path: 'src/old.ts', outdated: true });
		expect(old).not.toHaveProperty('line');
		expect(now).toMatchObject({ path: 'src/new.ts', line: 4 });
		expect(now).not.toHaveProperty('outdated');
	});

	it('does not call a comment on a whole file outdated', async () => {
		const wholeFile = {
			id: 5,
			body: 'About the file.',
			user: { login: 'ann' },
			created_at: '2026-10-30T09:00:00Z',
			author_association: 'OWNER',
			path: 'src/a.ts',
			line: null,
			subject_type: 'file'
		};
		const pullNine = { number: 9, html_url: 'u', head: { sha: 'abc' } };
		const { gh } = fakeGh(
			on('GET', 'repos/o/r/pulls/9/comments', () => ok([wholeFile])),
			on('GET', 'repos/o/r/issues/9/comments', () => ok([])),
			on('GET', 'repos/o/r/pulls/9/reviews', () => ok([])),
			on('GET', 'repos/o/r/pulls/9', () => ok(pullNine)),
			on('GET', 'repos/o/r/commits/abc/check-runs', () => ok({ check_runs: [] })),
			on('GET', 'repos/o/r/collaborators/ann/permission', () => ok({ permission: 'write' }))
		);
		const host = new GitHubCodeHost('o/r', gh, noGit);
		const [only] = await host.feedback({ id: 9, url: 'u' });
		expect(only).toMatchObject({ id: 'comment:5', path: 'src/a.ts', trusted: true });
		expect(only).not.toHaveProperty('line');
		expect(only).not.toHaveProperty('outdated');
	});

	it('reads every page of each list', async () => {
		const { github, host, pull, calls } = await world();
		github.grant('ann', 'write');
		for (let n = 1; n <= 230; n += 1) {
			const body = `Line ${String(n)}.`;
			github.lineComment(pull.id, { login: 'ann', body, path: 'a', line: n });
		}
		for (let n = 1; n <= 101; n += 1) github.say(pull.id, 'ann', `Talk ${String(n)}.`);
		for (let n = 1; n <= 100; n += 1) {
			github.review(pull.id, { login: 'ann', body: `Review ${String(n)}.` });
		}
		for (let n = 1; n <= 150; n += 1) {
			github.checkRun(pull.id, { name: `check ${String(n)}`, ...ACTIONS });
		}
		const got = await host.feedback(pull);
		const count = (kind: string) => got.filter((f) => f.kind === kind).length;
		expect(got.filter((f) => f.path === 'a')).toHaveLength(230);
		expect(count('comment')).toBe(331);
		expect(count('review')).toBe(100);
		expect(count('check')).toBe(150);
		expect(new Set(got.map((f) => f.id)).size).toBe(got.length);
		const pages = (path: string) => calls.filter((c) => c.includes(`${path}?`)).length;
		expect(pages('/pulls/1/comments')).toBe(3);
		expect(pages('/issues/1/comments')).toBe(2);
		// a list of exactly one full page is read on to its empty next page
		expect(pages('/pulls/1/reviews')).toBe(2);
		expect(pages('/check-runs')).toBe(2);
	});

	it('names the call that failed', async () => {
		const { gh } = fakeGh(
			on('GET', 'repos/o/r/pulls/9/comments', failed('gh: Bad credentials (HTTP 401)'))
		);
		const host = new GitHubCodeHost('o/r', gh, noGit);
		const reason = 'gh could not list the line comments on pull request #9: gh: Bad credentials';
		await expect(host.feedback({ id: 9, url: 'u' })).rejects.toThrow(
			new GitHubFailure(`${reason} (HTTP 401)`)
		);
	});
});

describe('GitHubCodeHost reply', () => {
	it('answers a line comment in its thread, with the footer, and writes nothing else', async () => {
		const { github, host, pull, calls } = await world();
		const id = github.lineComment(pull.id, { login: 'bob', body: 'Rename.', path: 'a', line: 2 });
		await host.reply(pull, idOf('comment', id), 'Renamed in abc123.');
		expect(github.thread(id)).toEqual([`Renamed in abc123.${FOOTER}`]);
		expect(github.said(pull.id)).toEqual([]);
		const posts = calls.filter((c) => c.includes('-X POST') && !c.includes('/pulls '));
		const where = `repos/o/r/pulls/${String(pull.id)}/comments/${String(id)}/replies`;
		expect(posts).toEqual([`api -X POST ${where} -f body=Renamed in abc123.${FOOTER}`]);
	});

	it('answers a reply in the thread of the comment it answers', async () => {
		const { github, host, pull } = await world();
		const comment = { login: 'bob', body: 'Rename.', path: 'a', line: 2 };
		const first = github.lineComment(pull.id, comment);
		const second = github.replyTo(first, 'bob', 'And the test.');
		await host.reply(pull, idOf('comment', second), 'Both done.');
		expect(github.thread(first)).toEqual(['And the test.', `Both done.${FOOTER}`]);
	});

	it('answers a comment in the conversation by quoting the start of it', async () => {
		const { github, host, pull } = await world();
		const long = `Why a loop?\n${'More. '.repeat(100)}`;
		const id = github.say(pull.id, 'bob', long).id;
		await host.reply(pull, idOf('comment', id), 'Because of order.');
		const [asked, answer = ''] = github.said(pull.id);
		expect(asked).toBe(long);
		expect(answer.startsWith('> Why a loop?\n> More. More. ')).toBe(true);
		expect(answer).toContain('…\n\nBecause of order.');
		expect(answer.endsWith(FOOTER)).toBe(true);
		expect(answer).not.toContain(long);
	});

	it('answers a review and a check in the conversation, quoting the start of each', async () => {
		const { github, host, pull } = await world();
		const asked = { login: 'bob', body: 'Please add a test.\nAnd docs.' };
		const review = github.review(pull.id, asked);
		const output = { text: 'boom' };
		const check = github.checkRun(pull.id, { name: 'build', ...ACTIONS, output });
		await host.reply(pull, idOf('review', review), 'Test added.');
		await host.reply(pull, idOf('check', check), 'Fixed.');
		expect(github.said(pull.id)).toEqual([
			`> Please add a test.\n> And docs.\n\nTest added.${FOOTER}`,
			`> build\n>\n> boom\n\nFixed.${FOOTER}`
		]);
	});

	it('puts the footer once on a reply that already ends with it', async () => {
		const { github, host, pull } = await world();
		const id = github.say(pull.id, 'bob', 'Hi.').id;
		await host.reply(pull, idOf('comment', id), `Done.${FOOTER}`);
		expect(github.said(pull.id)[1]?.split(FOOTER)).toHaveLength(2);
	});

	it('does not answer a line comment of another pull request as a conversation comment', async () => {
		const { github, host, pull } = await world();
		const other = await host.createDraft({
			title: 'U',
			head: 'factory/2-b',
			base: 'main',
			body: ''
		});
		const comment = { login: 'bob', body: 'There.', path: 'a', line: 1 };
		const elsewhere = idOf('comment', github.lineComment(other.id, comment));
		const gone = `GitHub has no ${elsewhere} on pull request #${String(pull.id)}.`;
		await expect(host.reply(pull, elsewhere, 'Done.')).rejects.toThrow(new GitHubFailure(gone));
		expect(github.thread(Number(elsewhere.slice('comment:'.length)))).toEqual([]);
	});

	it('refuses an id that names no feedback', async () => {
		const { host, pull } = await world();
		await expect(host.reply(pull, 'nonsense', 'x')).rejects.toThrow(
			new GitHubFailure('nonsense is no id of feedback.')
		);
		const gone = `GitHub has no review:12 on pull request #${String(pull.id)}.`;
		await expect(host.reply(pull, 'review:12', 'x')).rejects.toThrow(new GitHubFailure(gone));
	});
});

describe('GitHubCodeHost openPulls', () => {
	it('lists no pull request from a fork, whatever its branch is called', async () => {
		const { github, host, pull } = await world();
		github.pullFromFork('mallory/r', 'factory/1-a', 'Mine');
		expect((await host.openPulls('factory/')).map((p) => p.id)).toEqual([pull.id]);
	});

	it('reads every page of the open pull requests', async () => {
		const { host, pull, calls } = await world();
		const more: number[] = [];
		for (let n = 2; n <= 101; n += 1) {
			const head = `factory/${String(n)}-b`;
			more.push((await host.createDraft({ title: 'U', head, base: 'main', body: '' })).id);
		}
		expect((await host.openPulls('factory/')).map((p) => p.id)).toEqual([pull.id, ...more]);
		expect(calls.filter((c) => c.startsWith('api repos/o/r/pulls?state=open'))).toHaveLength(2);
	});

	it("reads a request for changes by its author's write access, and never Nightjar's own words as one", async () => {
		const { github, host, pull } = await world();
		github.grant('bob', 'write');
		github.review(pull.id, { login: 'bob', body: '', state: 'CHANGES_REQUESTED' });
		github.review(pull.id, { login: 'eve', body: 'No.', state: 'CHANGES_REQUESTED' });
		github.review(pull.id, { login: 'bob', body: `Mine.${FOOTER}`, state: 'CHANGES_REQUESTED' });
		github.review(pull.id, { login: 'bob', body: 'Good.', state: 'APPROVED' });
		const [shown] = await host.openPulls('factory/');
		expect(shown?.changesRequested.map((r) => [r.author, r.trusted])).toEqual([
			['bob', true],
			['eve', false]
		]);
		expect(shown?.branch).toBe('factory/1-a');
	});
});
