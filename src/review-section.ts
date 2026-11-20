// The Review section of a pull request body: each Review of the build and each Review round after it, in order, then what is still open.
import { issueLine, type Review } from './prompt.js';

// One thing that happened in the build's Review, in order: a Review, or the Review round after it.
export type ReviewStep =
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

const dollars = (n: number) => `$${n.toFixed(2)}`;

// What the build's last word on the Feature leaves open: the issues of its last Review, unless a round fixed them since and no Review has read the result.
function open(steps: readonly ReviewStep[]): Review['issues'] {
	for (const step of steps.toReversed()) {
		if (step.kind === 'review') return step.review?.issues ?? [];
		if (step.outcome === 'fixed') return [];
	}
	return [];
}

export function reviewSection(steps: readonly ReviewStep[]): string {
	let reviews = 0;
	const blocks = steps.map((step) => {
		if (step.kind === 'round') {
			return `### Review round ${String(step.round)}: ${step.outcome}, ${dollars(step.usd)}\n\n${step.text}`;
		}
		reviews += 1;
		const name = `### Review ${String(reviews)}`;
		if (step.review === null) return `${name}: did not finish`;
		const verdict = step.review.verdict === 'approve' ? 'Approve' : 'Changes asked';
		return `${name}: ${verdict}\n\n${step.review.summary}`;
	});
	const issues = open(steps);
	if (issues.length > 0) blocks.push(`### Still open\n\n${issues.map(issueLine).join('\n')}`);
	return `## Review\n\n${blocks.join('\n\n')}`;
}
