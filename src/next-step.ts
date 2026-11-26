import type { SignalNames } from './signals.js';

const tag = (name: string) => `\`${name}\``;

// A Next step as its numbered lines, which a Tracker comment and a view each lay out their own way.
export type NextStep = readonly string[];

export const nextStepText = (lines: NextStep) =>
	`**Next step**\n\n${lines.map((l, i) => `${String(i + 1)}. ${l}`).join('\n')}`;

const KEEP = '(keep it assigned to you)';

// A Next step that hands a Feature or Ticket back to Nightjar puts the person's task first and ends with this step: the Signal changes come last.
export const HAND_BACK = 'Then hand it back:';

// A handed-back Ticket leaves its Feature carrying needs-info, which only a person takes off.
const giveGo = (n: SignalNames) =>
	`on its Feature, remove ${tag(n.needsInfo)} and add ${tag(n.go)} ${KEEP}. Nightjar goes on from the branch.`;

const handBack = (n: SignalNames, from: string) =>
	`${HAND_BACK} on this Ticket, remove ${tag(from)} and add ${tag(n.ready)}; then ${giveGo(n)}`;

export type TicketHandBack = 'answer' | 'retry' | 'human';

export function ticketStep(n: SignalNames, kind: TicketHandBack): NextStep {
	switch (kind) {
		case 'answer':
			return ['Answer the questions above in a comment here.', handBack(n, n.needsInfo)];
		case 'retry':
			return [
				'Read the reason above and fix what it names, or edit the Ticket.',
				handBack(n, n.needsInfo)
			];
		case 'human':
			return [
				'Build it yourself, or answer the questions above and make the Ticket clear.',
				handBack(n, n.human)
			];
	}
}

const featureGo = (n: SignalNames) =>
	`on this Feature, remove ${tag(n.needsInfo)} and add ${tag(n.go)} ${KEEP}.`;

export const featureStopStep = (n: SignalNames): NextStep => [
	'Fix the cause named above.',
	`${HAND_BACK} ${featureGo(n)} Nightjar builds the Feature again.`
];

export function featureAfterRunStep(
	n: SignalNames,
	why: { readonly waiting: boolean; readonly red: boolean }
): NextStep {
	const todo = [
		...(why.red ? ['Fix the failing check on the branch.'] : []),
		...(why.waiting
			? [
					`Deal with the waiting Tickets above: answer their comments, then on each remove ${tag(n.needsInfo)} or ${tag(n.human)} and add ${tag(n.ready)}.`
				]
			: [])
	];
	if (todo.length === 0) {
		return ['Add a Ticket to the Feature, or close the Feature if it is done.'];
	}
	return [...todo, `${HAND_BACK} ${featureGo(n)} Nightjar goes on from the branch.`];
}

// A draft pull request that asks nothing more of Nightjar: it is the person's to review.
export const draftStep = (url: string): NextStep => [
	`Review the draft pull request ${url}. When it is right, mark it ready for review and merge it.`
];

// A Feature whose Workflow has `output: "note"` ends with the note in a draft pull request, for a person to read and act on.
export const noteStep = (url: string): NextStep => [
	`Read the note in ${url}.`,
	'Close this Feature if the note settles it, or follow up: write a Feature for what the note recommends.',
	'Merge the pull request to keep the note, or close it.'
];

// A draft pull request whose Pull checks Nightjar could not make green: the person's now, and its fix rounds still count.
export const pullChecksStep = (n: SignalNames): NextStep => [
	'Read the failing Pull checks above and fix them on the branch, or review the pull request: Nightjar leaves a pull request alone for good once a person pushes to it, reviews it or comments on it.',
	`${HAND_BACK} to have Nightjar build the Feature on its branch again, remove ${tag(n.human)} and add ${tag(n.go)} on this Feature ${KEEP}. The Pull-check fix rounds it had still count.`
];

// A Feature whose Review still asks for changes after Nightjar's Review rounds: the issues are the person's now.
export const reviewStep = (n: SignalNames): NextStep => [
	"Read the issues above and fix the ones that are right on the branch, or review the pull request: the Review is Nightjar's own and can be wrong.",
	`${HAND_BACK} to have Nightjar build the Feature on its branch again, remove ${tag(n.human)} and add ${tag(n.go)} on this Feature ${KEEP}. A new build gets its Review rounds again.`
];

// A Feedback round that was thrown away: its feedback stays unanswered, so the next Go starts a round on it again.
export const feedbackStep = (n: SignalNames): NextStep => [
	'Read why above: answer the feedback yourself on the pull request, or make it clear enough to act on there.',
	`${HAND_BACK} ${featureGo(n)} Nightjar goes on from the branch, and answers the feedback no commit has answered yet.`
];

// A pull request that has had its automatic Feedback rounds: a request for changes starts no more, and only a Go starts another round.
export const feedbackLimitStep = (n: SignalNames): NextStep => [
	'Answer the requests for changes on the pull request yourself, on its branch.',
	`${HAND_BACK} to have Nightjar answer them, remove ${tag(n.human)} and add ${tag(n.go)} on this Feature ${KEEP}. Only a Go starts another Feedback round on this pull request.`
];

// A push the Code host rejected because a person pushed to the branch: the draft is theirs, and Nightjar's work waits on a local side branch.
export const pushRejectedStep = (n: SignalNames, side: string): NextStep => [
	`Look at ${tag(side)}, a local branch in the checkout Nightjar runs in, and cherry-pick from it what you want.`,
	`${HAND_BACK} to have Nightjar build on top of your commits, remove ${tag(n.human)} and add ${tag(n.go)} on this Feature ${KEEP}. Or carry on by hand.`
];

// A person stopped the run: whatever made them stop is theirs to settle before the Go.
export const stoppedStep = (n: SignalNames): NextStep => [
	'Settle whatever made you stop the run, on the branch or in the Tickets.',
	`${HAND_BACK} add ${tag(n.go)} to this Feature ${KEEP}. Nightjar goes on from the branch.`
];
