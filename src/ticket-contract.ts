// What a Ticket must hold, in the shape docs/ticket-contract.md sets: read the same way from a Feature file and from the Tracker.

const HEADING = /^(#{1,6})\s/;
const CRITERIA = /^(#{1,6})\s+Acceptance criteria\s*$/i;
const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]\s+\S/;
const FENCE = /^\s*(```|~~~)/;
// the lines the build reads a Ticket's model and effort from (ticketLine in coding-agent.ts)
const SETTING = /^(?:\*\*)?(Model|Effort):(?:\*\*)?(.*)$/i;

// Whether the lines hold an "Acceptance criteria" heading with a checklist item under it,
// before the next heading of its level or above. A code block holds neither.
export function hasAcceptanceCriteria(lines: readonly string[]): boolean {
	let fenced = false;
	let under: number | null = null;
	for (const line of lines) {
		if (FENCE.test(line)) fenced = !fenced;
		if (fenced) continue;
		const criteria = CRITERIA.exec(line);
		if (criteria) {
			under = criteria[1]?.length ?? 1;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading && under !== null && (heading[1]?.length ?? 1) <= under) under = null;
		else if (under !== null && CHECKBOX.test(line)) return true;
	}
	return false;
}

// What a body says under its "Acceptance criteria" heading, up to the next heading of its level or above, as Markdown; null when it has no such heading. A code block holds no heading.
export function acceptanceCriteria(body: string): string | null {
	let fenced = false;
	let under: number | null = null;
	const found: string[] = [];
	for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
		if (FENCE.test(line)) fenced = !fenced;
		const criteria = fenced ? null : CRITERIA.exec(line);
		const heading = fenced ? null : HEADING.exec(line);
		if (under === null) {
			if (criteria) under = criteria[1]?.length ?? 1;
		} else if (heading && (heading[1]?.length ?? 1) <= under) break;
		else found.push(line);
	}
	return under === null ? null : found.join('\n').trim();
}

// The names of the Model and Effort lines that are there with no value, as "Model".
export function emptySettings(lines: readonly string[]): string[] {
	return lines.flatMap((line) => {
		const setting = SETTING.exec(line.trim());
		return setting !== null && (setting[2] ?? '').trim() === '' ? [setting[1] ?? ''] : [];
	});
}

// What a Ticket's body lacks against the contract, each fault worded for a person; none when it holds.
export function ticketFaults(body: string): string[] {
	const lines = body.replace(/\r\n/g, '\n').split('\n');
	const faults: string[] = [];
	if (!hasAcceptanceCriteria(lines)) {
		faults.push(
			'It has no "Acceptance criteria" heading with a checklist under it; add the heading with "- [ ]" items.'
		);
	}
	for (const name of emptySettings(lines)) {
		faults.push(`Its **${name}:** line has no value; give it one or leave the line out.`);
	}
	return faults;
}
