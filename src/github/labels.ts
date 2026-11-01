// A label that exists is never touched, so a team's own colours and descriptions stay.
import { firstLine } from '../git.js';
import { SIGNALS, type SignalNames } from '../signals.js';
import { GitHubApi, GitHubFailure, type GhRunner } from './api.js';

const MEANING = {
	go: 'Nightjar: build this Feature',
	ready: 'Nightjar: this Ticket is ready to be built',
	working: 'Nightjar: working on it now',
	needsInfo: 'Nightjar: needs an answer to go on',
	human: 'Nightjar: a person has to take it from here'
} as const;

// What was done for each label name, one line each.
export async function createSignalLabels(
	gh: GhRunner,
	repo: string,
	names: SignalNames
): Promise<string[]> {
	const api = new GitHubApi(repo, gh);
	const said: string[] = [];
	const seen = new Set<string>();
	for (const signal of SIGNALS) {
		const name = names[signal];
		if (seen.has(name)) continue;
		seen.add(name);
		const made = await api.raw([
			'-X',
			'POST',
			`repos/${repo}/labels`,
			'-f',
			`name=${name}`,
			'-f',
			`description=${MEANING[signal]}`
		]);
		if (made.ok) {
			said.push(`created the label ${name}`);
			continue;
		}
		// a refusal is only "exists already" when the label can be read back
		const there = await api.raw([`repos/${repo}/labels/${encodeURIComponent(name)}`]);
		if (!there.ok) {
			throw new GitHubFailure(
				`gh could not create the label ${name}: ${firstLine(made.err) || firstLine(made.out)}`
			);
		}
		said.push(`the label ${name} exists already`);
	}
	return said;
}
