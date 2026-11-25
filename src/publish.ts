// What Publish reads of a pull request (docs/adr/0006): the body Nightjar wrote, never a Signal, so the pull request stays the record.
import type { NightjarDraft } from './code-host.js';
import { TRAILER_PREFIX, trailersOf } from './worktree.js';

// What the build that wrote a pull request's body found, as Publish needs it.
export interface PublishMark {
	// every Ticket built, the check green and the build not paused
	readonly complete: boolean;
	// the last Review of the build said approve; false when it said changes, did not finish or is switched off
	readonly approved: boolean;
}

const MARK = /<!-- nightjar-publish: complete=(yes|no) approved=(yes|no) -->/g;

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

// The hidden line the build writes into the pull request body.
export function publishMark(mark: PublishMark): string {
	return `<!-- nightjar-publish: complete=${yesNo(mark.complete)} approved=${yesNo(mark.approved)} -->`;
}

// The mark a pull request body carries, the last one when it has several; null for a body written without one, which Publish never takes out of draft.
export function publishMarkOf(body: string): PublishMark | null {
	const last = [...body.matchAll(MARK)].at(-1);
	if (last === undefined) return null;
	return { complete: last[1] === 'yes', approved: last[2] === 'yes' };
}

const PUBLISHED = '<!-- nightjar-published -->';

// Whether Nightjar published this pull request itself: a person marking one ready leaves no such mark, so only Nightjar's own Publish keeps the Pull-check pass on it (docs/adr/0004).
export function publishedByNightjar(body: string): boolean {
	return body.includes(PUBLISHED);
}

// The body with the hidden mark that Nightjar took the pull request out of draft.
export function markPublished(body: string): string {
	return publishedByNightjar(body) ? body : `${body}\n\n${PUBLISHED}`;
}

// How long after a pull request opened a head commit with no Pull checks counts as green (docs/adr/0006): a Code host registers its checks a little after the push.
export const NO_CHECKS_WAIT_MS = 10 * 60_000;

// The commit message carries a trailer of Nightjar's, as every commit it makes does; it is how Publish and the Measures tell its commits from a person's.
export const hasTrailer = (message: string) =>
	[...trailersOf(message).keys()].some((k) => k.startsWith(TRAILER_PREFIX));

// Whether a draft meets the four conditions of Publish: the Feature was complete and the last Review approved (the body's mark), the Pull checks on the head commit finished green, and no person has engaged by reviewing, commenting or pushing. One Nightjar published already is no draft to publish.
export function readyToPublish(draft: NightjarDraft, now: Date): boolean {
	if (publishedByNightjar(draft.body)) return false;
	const mark = publishMarkOf(draft.body);
	if (mark === null || !mark.complete || !mark.approved) return false;
	if (draft.personEngaged) return false;
	// a Code host that does not list the commits cannot say a person did not push
	if (draft.commits === undefined || draft.commits.some((c) => !hasTrailer(c.message)))
		return false;
	const { checks } = draft;
	if (checks.pending || checks.failed.length > 0) return false;
	if ((draft.checkCount ?? 0) > 0) return true;
	// none yet: a Code host that registers its checks late is not mistaken for one with none
	const opened = Date.parse(draft.openedAt ?? '');
	return !Number.isNaN(opened) && now.getTime() - opened >= NO_CHECKS_WAIT_MS;
}
