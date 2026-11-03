import type { SignalNames } from './signals.js';

// The "Next step" every Nightjar comment ends with: what a person does, by the Signal names factory.json sets.
const tag = (name: string) => `\`${name}\``;

const steps = (lines: readonly string[]) =>
	`**Next step**\n\n${lines.map((l, i) => `${String(i + 1)}. ${l}`).join('\n')}`;

const giveGo = (n: SignalNames) =>
	`On its Feature, add ${tag(n.go)} (keep it assigned to you). Nightjar goes on from the branch.`;

const handBack = (n: SignalNames, from: string) =>
	`On this Ticket, remove ${tag(from)} and add ${tag(n.ready)}.`;

export const ticketAnswerStep = (n: SignalNames) =>
	steps(['Answer in a comment here.', handBack(n, n.needsInfo), giveGo(n)]);

export const ticketRetryStep = (n: SignalNames) =>
	steps([
		'Read the reason above and fix what it names, or edit the Ticket.',
		handBack(n, n.needsInfo),
		giveGo(n)
	]);

export const ticketHumanStep = (n: SignalNames) =>
	steps([
		'Build it yourself, or answer the questions above and make the Ticket clear.',
		`To hand it back to Nightjar, remove ${tag(n.human)} and add ${tag(n.ready)} on this Ticket.`,
		giveGo(n)
	]);

const featureGo = (n: SignalNames) =>
	`On this Feature, remove ${tag(n.needsInfo)} and add ${tag(n.go)} (keep it assigned to you).`;

export const featureStopStep = (n: SignalNames) =>
	steps(['Fix the cause named above.', featureGo(n), 'Nightjar builds the Feature again.']);

export const featureWaitingStep = (n: SignalNames) =>
	steps([
		`Deal with the waiting Tickets above: answer their comments, then on each remove ${tag(n.needsInfo)} or ${tag(n.human)} and add ${tag(n.ready)}.`,
		featureGo(n),
		'Nightjar goes on from the branch and updates the same draft pull request.'
	]);

export const stoppedStep = (n: SignalNames) =>
	steps([
		`To run this Feature again, add ${tag(n.go)} to it (keep it assigned to you). Nightjar goes on from the branch.`
	]);

export const reviewStep = (verdict: 'approve' | 'changes') =>
	verdict === 'approve'
		? steps([
				'Nothing is waiting on you here. Read the diff, mark the pull request ready and merge.'
			])
		: steps([
				'Fix the issues above on the branch, or decide they can stay.',
				'Then mark the pull request ready and merge. Nightjar does not answer this comment.'
			]);
