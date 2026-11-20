// What Publish reads of a pull request (docs/adr/0006): the body Nightjar wrote, never a Signal, so the pull request stays the record.

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
