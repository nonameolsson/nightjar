// The GitHub adapters against the Adapter contract suites, over a fake GitHub behind `gh api`: no
// spec here reaches the network.
import { describe, it } from 'vitest';
import { GitHubTracker, trackerContract, type SignalNames, type TrackerWorld } from '../index.js';
import { FakeGitHub } from './fake-github.js';

// the Go has a name of its own, as the contract asks of every Signal
const NAMES: SignalNames = {
	go: 'factory-go',
	ready: 'ready-for-agent',
	working: 'agent-working',
	needsInfo: 'needs-info',
	human: 'ready-for-human'
};

function gitHubTracker(world: TrackerWorld) {
	const github = new FakeGitHub('o/r', world.person);
	const numbers = new Map<string, number>();
	const id = (key: string) => {
		const found = numbers.get(key);
		if (found === undefined) throw new Error(`the world has no item ${key}`);
		return found;
	};
	for (const item of world.items) {
		numbers.set(
			item.key,
			github.issue({
				title: item.title,
				body: item.body ?? null,
				state: item.open === false ? 'closed' : 'open',
				labels: (item.signals ?? []).map((s) => NAMES[s]),
				assignees: item.assignees ?? []
			})
		);
	}
	for (const item of world.items) {
		for (const child of item.children ?? []) github.addSubIssue(id(item.key), id(child));
		for (const blocker of item.blockedBy ?? []) github.block(id(item.key), id(blocker));
		for (const c of item.comments ?? []) github.say(id(item.key), c.author, c.body);
	}
	for (const person of world.trusted) github.grant(person, 'write');
	return Promise.resolve({ tracker: new GitHubTracker('o/r', github.gh, NAMES), id });
}

describe('GitHubTracker meets the Tracker contract', () => {
	for (const c of trackerContract) it(c.name, () => c.run(gitHubTracker));
});
