// A Feature file: one Feature and its Tickets as Markdown, in the shape docs/ticket-contract.md sets.
import type { ItemText } from './tracker.js';

export class FeatureFileError extends Error {}

export interface PlannedTicket extends ItemText {
	// its place in the file, by which the Tickets below it name it as a blocker
	readonly number: number;
	readonly blockedBy: readonly number[];
}

export interface FeaturePlan {
	readonly feature: ItemText;
	readonly tickets: readonly PlannedTicket[];
}

const TITLE = /^#\s+(.*\S)\s*$/;
const TICKET = /^##\s+Ticket\s+(\S+?):\s*(.*?)\s*$/i;
const BLOCKED_BY = /^(?:\*\*)?Blocked by:(?:\*\*)?(.*)$/i;
// the lines the build reads a Ticket's model and effort from (ticketLine in build.ts)
const SETTING = /^(?:\*\*)?(Model|Effort):(?:\*\*)?(.*)$/i;
const CRITERIA = /^#{1,6}\s+Acceptance criteria\s*$/i;
const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]\s+\S/;
const FENCE = /^\s*(```|~~~)/;

const tidy = (lines: readonly string[]) => lines.join('\n').trim();

interface Section {
	readonly number: string;
	readonly title: string;
	// the line of its heading, counted from 1
	readonly line: number;
	readonly lines: string[];
}

// The Feature and its Tickets, or a FeatureFileError that names every fault with its line.
export function readFeatureFile(text: string): FeaturePlan {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const faults: string[] = [];
	const first = lines.findIndex((l) => l.trim() !== '');
	const title = TITLE.exec(lines[first] ?? '')?.[1];
	if (title === undefined) {
		faults.push(
			`line ${String(first + 1)}: the file starts with the Feature's title, as "# Title"`
		);
	}
	const featureLines: string[] = [];
	const sections: Section[] = [];
	let fenced = false;
	lines.forEach((line, i) => {
		if (i <= first) return;
		if (FENCE.test(line)) fenced = !fenced;
		const heading = fenced ? null : TICKET.exec(line);
		if (heading) {
			sections.push({ number: heading[1] ?? '', title: heading[2] ?? '', line: i + 1, lines: [] });
		} else (sections.at(-1)?.lines ?? featureLines).push(line);
	});
	if (sections.length === 0)
		faults.push('the file holds no Ticket; start each with "## Ticket 1: Title"');

	const tickets: PlannedTicket[] = [];
	sections.forEach((section, i) => {
		const number = i + 1;
		const name = `Ticket ${section.number}`;
		const at = `line ${String(section.line)}`;
		if (section.number !== String(number)) {
			faults.push(
				`${at}: ${name} is the Ticket numbered ${String(number)}; number them 1, 2, 3 in order`
			);
		}
		if (section.title === '') faults.push(`${at}: ${name} has no title`);
		const blockedBy: number[] = [];
		const body: string[] = [];
		for (const line of section.lines) {
			const blockers = BLOCKED_BY.exec(line.trim());
			if (blockers === null) {
				body.push(line);
				continue;
			}
			const listed = (blockers[1] ?? '').trim();
			if (/^none$/i.test(listed)) continue;
			for (const part of listed.split(',').map((p) => p.trim())) {
				const blocker = /^\d+$/.test(part) ? Number(part) : NaN;
				if (!(blocker >= 1 && blocker < number)) {
					faults.push(
						`${at}: ${name} is blocked by "${part}"; name the numbers of Tickets above it, as "**Blocked by:** 1, 2"`
					);
				} else if (!blockedBy.includes(blocker)) blockedBy.push(blocker);
			}
		}
		for (const line of body) {
			const setting = SETTING.exec(line.trim());
			if (setting !== null && (setting[2] ?? '').trim() === '') {
				faults.push(
					`${at}: ${name} has an empty ${setting[1] ?? ''} line; give it a value or leave it out`
				);
			}
		}
		const criteria = body.findIndex((l) => CRITERIA.test(l));
		if (criteria === -1 || !body.slice(criteria).some((l) => CHECKBOX.test(l))) {
			faults.push(
				`${at}: ${name} has no acceptance criteria; add an "Acceptance criteria" heading with "- [ ]" items`
			);
		}
		tickets.push({ number, title: section.title, body: tidy(body), blockedBy });
	});

	if (faults.length > 0) throw new FeatureFileError(faults.join('\n'));
	return { feature: { title: title ?? '', body: tidy(featureLines) }, tickets };
}
