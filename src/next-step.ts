import type { SignalNames } from './signals.js';

const tag = (name: string) => `\`${name}\``;

// A Next step as its numbered lines, which a Tracker comment and a view each lay out their own way.
export type NextStep = readonly string[];

export const nextStepText = (lines: NextStep) =>
	`**Next step**\n\n${lines.map((l, i) => `${String(i + 1)}. ${l}`).join('\n')}`;

const KEEP = '(keep it assigned to you)';

// A handed-back Ticket leaves its Feature carrying needs-info, which only a person takes off.
const giveGo = (n: SignalNames) =>
	`On its Feature, remove ${tag(n.needsInfo)} and add ${tag(n.go)} ${KEEP}. Nightjar goes on from the branch.`;

const handBack = (n: SignalNames, from: string) =>
	`On this Ticket, remove ${tag(from)} and add ${tag(n.ready)}.`;

export type TicketHandBack = 'answer' | 'retry' | 'human';

export function ticketStep(n: SignalNames, kind: TicketHandBack): NextStep {
	switch (kind) {
		case 'answer':
			return ['Answer in a comment here.', handBack(n, n.needsInfo), giveGo(n)];
		case 'retry':
			return [
				'Read the reason above and fix what it names, or edit the Ticket.',
				handBack(n, n.needsInfo),
				giveGo(n)
			];
		case 'human':
			return [
				'Build it yourself, or answer the questions above and make the Ticket clear.',
				`To hand it back to Nightjar, remove ${tag(n.human)} and add ${tag(n.ready)} on this Ticket.`,
				giveGo(n)
			];
	}
}

const featureGo = (n: SignalNames) =>
	`On this Feature, remove ${tag(n.needsInfo)} and add ${tag(n.go)} ${KEEP}.`;

export const featureStopStep = (n: SignalNames): NextStep => [
	'Fix the cause named above.',
	featureGo(n),
	'Nightjar builds the Feature again.'
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
	return [...todo, featureGo(n), 'Nightjar goes on from the branch.'];
}

export const stoppedStep = (n: SignalNames): NextStep => [
	`To run this Feature again, add ${tag(n.go)} to it ${KEEP}. Nightjar goes on from the branch.`
];
