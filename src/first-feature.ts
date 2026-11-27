// The tour's first Feature: a fixed template that turns one sentence into a Feature with one Ticket.
import { readdirSync } from 'node:fs';
import { ticketLine } from './coding-agent.js';
import type { FeaturePlan } from './feature-file.js';
import { ticketFaults } from './ticket-contract.js';

// both Trackers take a title this long
const TITLE_MAX = 255;

// The sentence offered, which a person takes with Enter.
export function suggestedSentence(root: string): string {
	const hasReadme = readdirSync(root).some((name) => /^readme(\.\w+)?$/i.test(name));
	return hasReadme
		? "Add a short 'Built with Nightjar' note to the README"
		: 'Create a README with one line about this repo';
}

export function firstFeature(sentence: string): FeaturePlan {
	const body = [
		sentence,
		'',
		'## Acceptance criteria',
		'',
		`- [ ] ${sentence}`,
		'- [ ] the check passes'
	].join('\n');
	return {
		feature: { title: sentence, body: sentence },
		tickets: [{ number: 1, title: sentence, body, blockedBy: [] }]
	};
}

// Why a sentence makes no Feature, or null when it will do.
export function sentenceProblem(sentence: string): string | null {
	if (!/\S/.test(sentence)) return 'say in one sentence what to build';
	if (sentence.length > TITLE_MAX)
		return `keep it to ${String(TITLE_MAX)} characters: it is the title too`;
	// a sentence that opens a code block, or reads as a setting, would change what the Ticket says
	const body = firstFeature(sentence).tickets[0]?.body ?? '';
	const names = ['Model', 'Effort', 'Workflow', 'Base'];
	const setting = names.some((name) => ticketLine(body, name) !== undefined);
	return setting || ticketFaults(body).length > 0
		? 'write it as a plain sentence, with no Markdown at its start'
		: null;
}

const indented = (text: string) => text.split('\n').map((line) => (line ? `    ${line}` : ''));

// The Feature and its Ticket as the person reads them before they are made.
export function shownFeature({ feature, tickets }: FeaturePlan): string[] {
	return [
		`  Feature: ${feature.title}`,
		...indented(feature.body),
		...tickets.flatMap((t) => [`  Ticket: ${t.title}`, ...indented(t.body)])
	];
}
