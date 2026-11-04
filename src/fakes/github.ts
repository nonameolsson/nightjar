// The GitHub of the machine of stand-ins: what a spec passes as the Host's `gh`, where the machine's own `gh` cannot be reached.
import { FakeGitHub } from '../github/fake-github.js';

// o/r, signed in as ann, with Feature #1 holding the Go and its Ticket #2.
export function oneEscape(): FakeGitHub {
	const github = new FakeGitHub('o/r', 'ann');
	const feature = github.issue({
		title: 'One escape',
		body: '',
		state: 'open',
		labels: ['factory-go'],
		assignees: ['ann']
	});
	const ticket = github.issue({
		title: 'Share the escape',
		body: '',
		state: 'open',
		labels: ['ready-for-agent'],
		assignees: ['ann']
	});
	github.addSubIssue(feature, ticket);
	return github;
}
