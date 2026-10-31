import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_NAMES, type SignalNames } from '../signals.js';
import { GitHubFailure } from './api.js';
import { failed, fakeGh, ok, on } from './fake-gh.js';
import { GitHubTracker } from './tracker.js';

const rawIssue = (number: number, over: Record<string, unknown> = {}) => ({
	number,
	title: `Issue ${String(number)}`,
	body: 'the body',
	state: 'open',
	labels: [{ name: 'ready-for-agent' }],
	assignees: [{ login: 'ann' }],
	user: { login: 'ann' },
	...over
});

const rawComment = (login: string, body: string, association = 'NONE') => ({
	body,
	user: { login },
	created_at: '2026-10-30T09:00:00Z',
	author_association: association
});

const tracker = (
	gh: ReturnType<typeof fakeGh>['gh'],
	names: SignalNames = DEFAULT_SIGNAL_NAMES,
	trusted?: readonly string[]
) => new GitHubTracker('o/r', gh, names, trusted);

const MINE: SignalNames = {
	go: 'ship-it',
	ready: 'queued',
	working: 'bot-busy',
	needsInfo: 'bot-asks',
	human: 'over-to-you'
};

describe('GitHubTracker', () => {
	it('names the signed-in person', async () => {
		const { gh } = fakeGh(on('GET', 'user', ok({ login: 'ann' })));
		expect(await tracker(gh).me()).toBe('ann');
	});

	it('lists the open Features assigned to a person with the Go, oldest first, and no pull request', async () => {
		const { gh, calls } = fakeGh(
			on(
				'GET',
				'repos/o/r/issues',
				ok([
					rawIssue(1, { sub_issues_summary: { total: 2 } }),
					rawIssue(2, { sub_issues_summary: { total: 0 } }),
					rawIssue(3, { sub_issues_summary: { total: 1 }, pull_request: {} })
				])
			)
		);
		const features = await tracker(gh).assignedFeatures('ann');
		expect(features).toEqual([{ id: 1, title: 'Issue 1', body: 'the body' }]);
		expect(Object.fromEntries(calls[0]?.query ?? [])).toMatchObject({
			assignee: 'ann',
			labels: DEFAULT_SIGNAL_NAMES.go,
			state: 'open',
			sort: 'created',
			direction: 'asc'
		});
	});

	it('reads a Feature', async () => {
		const { gh } = fakeGh(on('GET', 'repos/o/r/issues/1', ok(rawIssue(1, { body: null }))));
		expect(await tracker(gh).feature(1)).toEqual({ id: 1, title: 'Issue 1', body: '' });
	});

	it('reads the Tickets in the Feature order, with their Signals and blockers', async () => {
		const { gh } = fakeGh(
			on(
				'GET',
				'repos/o/r/issues/1/sub_issues',
				ok([
					rawIssue(3, { labels: [{ name: 'needs-info' }, { name: 'bug' }] }),
					rawIssue(2, { state: 'closed' })
				])
			),
			on(
				'GET',
				'repos/o/r/issues/3/dependencies/blocked_by',
				ok([rawIssue(2, { state: 'closed' }), rawIssue(4)])
			),
			on('GET', 'repos/o/r/issues/2/dependencies/blocked_by', ok([]))
		);
		expect(await tracker(gh).tickets(1)).toEqual([
			{
				id: 3,
				title: 'Issue 3',
				body: 'the body',
				open: true,
				signals: ['needsInfo'],
				blockedBy: [
					{ id: 2, open: false },
					{ id: 4, open: true }
				]
			},
			{
				id: 2,
				title: 'Issue 2',
				body: 'the body',
				open: false,
				signals: ['ready'],
				blockedBy: []
			}
		]);
	});

	it('trusts the comments of people with write, maintain or admin, asking once per person', async () => {
		const { gh, calls } = fakeGh(
			on(
				'GET',
				'repos/o/r/issues/5/comments',
				ok([
					rawComment('ann', 'first'),
					rawComment('bob', 'second'),
					rawComment('eve', 'third'),
					rawComment('ann', 'fourth')
				])
			),
			on('GET', 'repos/o/r/collaborators/ann/permission', ok({ permission: 'write' })),
			on('GET', 'repos/o/r/collaborators/bob/permission', ok({ permission: 'read' }))
		);
		const comments = await tracker(gh).comments(5);
		expect(comments.map((c) => [c.author, c.body, c.trusted])).toEqual([
			['ann', 'first', true],
			['bob', 'second', false],
			['eve', 'third', false],
			['ann', 'fourth', true]
		]);
		expect(comments[0]?.at).toBe('2026-10-30T09:00:00Z');
		expect(calls.filter((c) => c.path.endsWith('/permission'))).toHaveLength(3);
	});

	// A proxy that refuses the permission call would otherwise drop the person's own answers.
	it("falls back on the comment's author association when the permission call is refused", async () => {
		const refused = failed('gh: not permitted through this proxy. (HTTP 403)');
		const { gh } = fakeGh(
			on(
				'GET',
				'repos/o/r/issues/5/comments',
				ok([rawComment('ann', 'mine', 'OWNER'), rawComment('bob', 'theirs', 'NONE')])
			),
			on('GET', 'repos/o/r/collaborators/ann/permission', refused),
			on('GET', 'repos/o/r/collaborators/bob/permission', refused)
		);
		const comments = await tracker(gh).comments(5);
		expect(comments.map((c) => c.trusted)).toEqual([true, false]);
	});

	it('fails on a refused permission call when the comment carries no association', async () => {
		const { gh } = fakeGh(
			on(
				'GET',
				'repos/o/r/issues/5/comments',
				ok([{ ...rawComment('ann', 'x'), author_association: undefined }])
			),
			on(
				'GET',
				'repos/o/r/collaborators/ann/permission',
				failed('gh: not permitted through this proxy. (HTTP 403)')
			)
		);
		await expect(tracker(gh).comments(5)).rejects.toThrow(
			/gh could not read the permission of ann: .*HTTP 403/
		);
	});

	it('adds and removes a Signal by its name, and takes off one the issue lacks without a fault', async () => {
		const { gh, calls } = fakeGh(on('POST', 'repos/o/r/issues/7/labels', ok([])));
		const t = tracker(gh);
		await t.addSignal(7, 'working');
		await expect(t.removeSignal(7, 'needsInfo')).resolves.toBeUndefined();
		expect(calls.map((c) => [c.method, c.path, c.fields])).toEqual([
			['POST', 'repos/o/r/issues/7/labels', { 'labels[]': ['agent-working'] }],
			['DELETE', 'repos/o/r/issues/7/labels/needs-info', {}]
		]);
	});

	it('comments with the body as one raw field', async () => {
		const { gh, calls } = fakeGh(on('POST', 'repos/o/r/issues/7/comments', ok({})));
		await tracker(gh).comment(7, '@here $(rm -rf) body');
		expect(calls[0]?.fields).toEqual({ body: '@here $(rm -rf) body' });
		expect(calls[0]?.args).toContain('-f');
	});

	it('references a Ticket by #N', () => {
		expect(tracker(fakeGh().gh).reference(12)).toEqual({ id: 12, text: '#12' });
	});

	it("names the call and gh's reason when a call fails", async () => {
		const { gh } = fakeGh(
			on('GET', 'repos/o/r/issues/1', failed('HTTP 401: Bad credentials\nmore'))
		);
		await expect(tracker(gh).feature(1)).rejects.toThrow(
			new GitHubFailure('gh could not read issue #1: HTTP 401: Bad credentials')
		);
	});

	describe('Signal names from config', () => {
		it('lists the Features that carry the Go under its configured name', async () => {
			const { gh, calls } = fakeGh(on('GET', 'repos/o/r/issues', ok([])));
			await tracker(gh, MINE).assignedFeatures('ann');
			expect(calls[0]?.query.get('labels')).toBe('ship-it');
		});

		it('reads each Signal from the label of its configured name', async () => {
			const labels = ['ship-it', 'queued', 'bot-busy', 'bot-asks', 'over-to-you'];
			const { gh } = fakeGh(
				on(
					'GET',
					'repos/o/r/issues/1/sub_issues',
					ok([
						rawIssue(2, { labels: labels.map((name) => ({ name })) }),
						rawIssue(3, { labels: [{ name: 'ready-for-agent' }, { name: 'agent-working' }] })
					])
				),
				on('GET', 'repos/o/r/issues/2/dependencies/blocked_by', ok([])),
				on('GET', 'repos/o/r/issues/3/dependencies/blocked_by', ok([]))
			);
			const found = await tracker(gh, MINE).tickets(1);
			expect(found.map((t) => t.signals)).toEqual([
				['go', 'ready', 'working', 'needsInfo', 'human'],
				[]
			]);
		});

		it('adds and removes a Signal under its configured name', async () => {
			const { gh, calls } = fakeGh(on('POST', 'repos/o/r/issues/7/labels', ok([])));
			const t = tracker(gh, MINE);
			await t.addSignal(7, 'needsInfo');
			await t.removeSignal(7, 'go');
			expect(calls.map((c) => [c.method, c.path, c.fields])).toEqual([
				['POST', 'repos/o/r/issues/7/labels', { 'labels[]': ['bot-asks'] }],
				['DELETE', 'repos/o/r/issues/7/labels/ship-it', {}]
			]);
		});

		it('with the Go named as ready, one label is both, as before the Go had a mark of its own', async () => {
			const one = { ...DEFAULT_SIGNAL_NAMES, go: 'ready-for-agent' };
			const { gh, calls } = fakeGh(
				on('GET', 'repos/o/r/issues', ok([rawIssue(1, { sub_issues_summary: { total: 1 } })]))
			);
			const features = await tracker(gh, one).assignedFeatures('ann');
			expect(features.map((f) => f.id)).toEqual([1]);
			expect(calls[0]?.query.get('labels')).toBe('ready-for-agent');
		});

		it('never reads needs-triage or wontfix, and never sets them', async () => {
			const { gh, calls } = fakeGh(
				on(
					'GET',
					'repos/o/r/issues/1/sub_issues',
					ok([rawIssue(2, { labels: [{ name: 'needs-triage' }, { name: 'wontfix' }] })])
				),
				on('GET', 'repos/o/r/issues/2/dependencies/blocked_by', ok([])),
				on('GET', 'repos/o/r/issues', ok([])),
				on('POST', 'repos/o/r/issues/2/labels', ok([]))
			);
			const t = tracker(gh);
			const [ticket] = await t.tickets(1);
			expect(ticket?.signals).toEqual([]);
			await t.assignedFeatures('ann');
			for (const signal of ['go', 'ready', 'working', 'needsInfo', 'human'] as const) {
				await t.addSignal(2, signal);
				await t.removeSignal(2, signal);
			}
			expect(JSON.stringify(calls)).not.toMatch(/needs-triage|wontfix/);
		});
	});

	describe('a trusted list', () => {
		const comments = ok([
			rawComment('Ann', 'a'),
			rawComment('bob', 'b', 'OWNER'),
			rawComment('eve', 'c', 'MEMBER')
		]);

		it('replaces write access: only the logins it names are trusted, whatever their permission', async () => {
			const { gh, calls } = fakeGh(
				on('GET', 'repos/o/r/issues/5/comments', comments),
				on('GET', 'repos/o/r/collaborators/bob/permission', ok({ permission: 'admin' }))
			);
			const got = await tracker(gh, DEFAULT_SIGNAL_NAMES, ['eve', 'ann']).comments(5);
			// GitHub logins are case-insensitive
			expect(got.map((c) => [c.author, c.trusted])).toEqual([
				['Ann', true],
				['bob', false],
				['eve', true]
			]);
			expect(calls.filter((c) => c.path.endsWith('/permission'))).toEqual([]);
		});

		it('trusts nobody when it is empty', async () => {
			const { gh } = fakeGh(on('GET', 'repos/o/r/issues/5/comments', comments));
			const got = await tracker(gh, DEFAULT_SIGNAL_NAMES, []).comments(5);
			expect(got.map((c) => c.trusted)).toEqual([false, false, false]);
		});
	});
});
