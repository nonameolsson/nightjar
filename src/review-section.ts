// The Review section of a pull request body: each Review of the build and each Review round after it, in order, then what is still open, then the issues the rounds declined with their reasons.
import { declinedLine, issueLine, type Declined, type Review } from './prompt.js';
import { dollars } from './view-text.js';

// One Session of the build's Review, in order: a Review, or the Review round after it.
export type ReviewSession =
	// null when the Review did not finish
	| { readonly kind: 'review'; readonly review: Review | null }
	| {
			readonly kind: 'round';
			readonly round: number;
			// a round that landed one commit, or one thrown away
			readonly outcome: 'fixed' | 'thrown away';
			// the round's summary, or why it was thrown away
			readonly text: string;
			// what the round and its fix rounds cost
			readonly usd: number;
	  };

// What the build's last word on the Feature leaves open: the issues of its last Review, unless a round fixed them since and no Review has read the result.
function open(sessions: readonly ReviewSession[]): Review['issues'] {
	for (const session of sessions.toReversed()) {
		if (session.kind === 'review') return session.review?.issues ?? [];
		if (session.outcome === 'fixed') return [];
	}
	return [];
}

export function reviewSection(
	sessions: readonly ReviewSession[],
	declined: readonly Declined[] = []
): string {
	let reviews = 0;
	const blocks = sessions.map((session) => {
		if (session.kind === 'round') {
			return `### Review round ${String(session.round)}: ${session.outcome}, ${dollars(session.usd)}\n\n${session.text}`;
		}
		reviews += 1;
		const name = `### Review ${String(reviews)}`;
		if (session.review === null) return `${name}: did not finish`;
		const verdict = session.review.verdict === 'approve' ? 'Approve' : 'Changes asked';
		return `${name}: ${verdict}\n\n${session.review.summary}`;
	});
	const issues = open(sessions);
	if (issues.length > 0) blocks.push(`### Still open\n\n${issues.map(issueLine).join('\n')}`);
	if (declined.length > 0) {
		blocks.push(`### Issues declined\n\n${declined.map(declinedLine).join('\n')}`);
	}
	return `## Review\n\n${blocks.join('\n\n')}`;
}
