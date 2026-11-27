import { describe, expect, it } from 'vitest';
import type { NightjarDraft } from './code-host.js';
import {
	markPublished,
	NO_CHECKS_WAIT_MS,
	publishedByNightjar,
	publishMark,
	publishMarkOf,
	readyToPublish
} from './publish.js';

describe('the publish mark in a pull request body', () => {
	it('gives back whether the Feature was complete and the last Review approved', () => {
		for (const complete of [true, false]) {
			for (const approved of [true, false]) {
				const body = `Nightjar built it.\n\n## Review\n\nApprove: fine.\n\n${publishMark({ complete, approved })}`;
				expect(publishMarkOf(body)).toEqual({ complete, approved });
			}
		}
	});

	it('is hidden: an HTML comment on a line of its own', () => {
		const mark = publishMark({ complete: true, approved: true });
		expect(mark.startsWith('<!-- ')).toBe(true);
		expect(mark.endsWith(' -->')).toBe(true);
		expect(mark).not.toContain('\n');
	});

	it('gives nothing for a body written without it, as one by an earlier Nightjar or a person', () => {
		expect(publishMarkOf('Nightjar built all of #1 One.\n\n<!-- nightjar-feature: 1 -->')).toBe(
			null
		);
		expect(publishMarkOf('')).toBe(null);
	});

	it('still reads once later sections are added after it', () => {
		const body = `Built.\n\n${publishMark({ complete: true, approved: false })}\n\n## Pull checks\n\nRound 1 pushed.\n\n<!-- nightjar-pull-checks: handed to a person -->`;
		expect(publishMarkOf(body)).toEqual({ complete: true, approved: false });
	});
});

describe('the mark that Nightjar published a pull request', () => {
	it('is on a body once Nightjar marks it, and on no other', () => {
		expect(publishedByNightjar('Built.')).toBe(false);
		expect(publishedByNightjar(markPublished('Built.'))).toBe(true);
	});

	it('keeps the body before it, and is written once however often it is marked', () => {
		const once = markPublished('Built.');
		expect(once.startsWith('Built.\n\n')).toBe(true);
		expect(markPublished(once)).toBe(once);
	});
});

describe('readyToPublish', () => {
	const OPENED = '2026-10-30T09:00:00Z';
	const at = (minutes: number) => new Date(Date.parse(OPENED) + minutes * 60_000);
	const built = 'Build #2 Share it\n\nFactory-Ticket: 2\nFactory-Session: s-1';
	const draft = (over: Partial<NightjarDraft> = {}): NightjarDraft => ({
		pull: { id: 7, url: 'https://example.test/pull/7' },
		branch: 'factory/1-one',
		headCommit: 'abc',
		body: `Built.\n\n${publishMark({ complete: true, approved: true })}`,
		checks: { pending: false, failed: [] },
		personEngaged: false,
		openedAt: OPENED,
		checkCount: 1,
		commits: [{ message: built, at: OPENED }],
		...over
	});

	it('is ready when the Feature was complete, the last Review approved, the Pull checks are green and no person engaged', () => {
		expect(readyToPublish(draft(), at(1))).toBe(true);
	});

	it('waits on a Feature that was not complete, a last Review that did not approve, or a body without the mark', () => {
		const marked = (complete: boolean, approved: boolean) =>
			draft({ body: `Built.\n\n${publishMark({ complete, approved })}` });
		expect(readyToPublish(marked(false, true), at(1))).toBe(false);
		expect(readyToPublish(marked(true, false), at(1))).toBe(false);
		expect(readyToPublish(draft({ body: 'Built.' }), at(1))).toBe(false);
	});

	it('waits while a Pull check runs, and on one that failed', () => {
		expect(readyToPublish(draft({ checks: { pending: true, failed: [] } }), at(1))).toBe(false);
		const failed = [{ check: 'CI / test', job: 'test', step: 'npm test', logTail: '1 failed' }];
		expect(readyToPublish(draft({ checks: { pending: false, failed } }), at(1))).toBe(false);
	});

	it('never publishes once a person reviewed, commented or pushed', () => {
		expect(readyToPublish(draft({ personEngaged: true }), at(1))).toBe(false);
		const pushed = [
			{ message: built, at: OPENED },
			{ message: 'Fix a typo', at: OPENED }
		];
		expect(readyToPublish(draft({ commits: pushed }), at(1))).toBe(false);
	});

	it("reads a Nightjar trailer only in a commit message's last paragraph", () => {
		const quoted = { message: 'Fix a typo\n\nFactory-Ticket: 2\n\nSigned-off-by: Ann', at: OPENED };
		expect(readyToPublish(draft({ commits: [quoted] }), at(1))).toBe(false);
	});

	it('waits on a Code host that gives no commits, opened time or count of Pull checks', () => {
		const { commits: _c, ...noCommits } = draft();
		expect(readyToPublish(noCommits, at(1))).toBe(false);
		const { openedAt: _o, ...noOpened } = draft({ checkCount: 0 });
		expect(readyToPublish(noOpened, at(60))).toBe(false);
	});

	it(`counts a head commit with no Pull checks as green only ${String(NO_CHECKS_WAIT_MS / 60_000)} minutes after the pull request opened`, () => {
		const none = draft({ checkCount: 0 });
		expect(readyToPublish(none, at(NO_CHECKS_WAIT_MS / 60_000 - 1))).toBe(false);
		expect(readyToPublish(none, at(NO_CHECKS_WAIT_MS / 60_000))).toBe(true);
	});

	it('waits on a draft the Code host says conflicts while the Conflict fix is on, and only then', () => {
		const on = { conflicts: true };
		expect(readyToPublish(draft({ conflicts: 'yes' }), at(1), on)).toBe(false);
		expect(readyToPublish(draft({ conflicts: 'no' }), at(1), on)).toBe(true);
		expect(readyToPublish(draft({ conflicts: 'unknown' }), at(1), on)).toBe(true);
		expect(readyToPublish(draft({ conflicts: 'yes' }), at(1))).toBe(true);
	});

	it('is never ready again once Nightjar published it', () => {
		const published = draft();
		expect(readyToPublish({ ...published, body: markPublished(published.body) }, at(1))).toBe(
			false
		);
	});
});
