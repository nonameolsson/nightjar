// The recap: how to use Nightjar from here on, one piece of output at the end of a setup.

export interface Recap {
	// the name the Go has on this repo's Tracker
	readonly go: string;
	// the link of the draft pull request a build opened, when one did
	readonly pullRequest?: string;
	// marks a word where it is first explained
	readonly bold: (words: string) => string;
}

export function recap({ go, pullRequest, bold }: Recap): string {
	return [
		...(pullRequest === undefined ? [] : [`Your draft pull request: ${pullRequest}`]),
		'From here on:',
		'  1. Commit factory.json and .gitignore, so that your team gets the setup.',
		'  2. Write Features with `nightjar create`, with `/nightjar:feature` in Claude Code, or by hand.',
		`     Nightjar builds a ${bold('Feature')} only when it is assigned to you and carries the ${bold('Go')}. To give the Go, add \`${go}\` to the Feature.`,
		`     A ${bold('Ticket')} is one buildable child of a Feature, built as one commit. Each Feature ends as one ${bold('draft pull request')}, for you to review.`,
		'  3. `nightjar --watch` builds Features as they come.',
		'  4. `nightjar ui` shows what Nightjar is doing.',
		'  5. `nightjar doctor` is for when something is wrong.'
	].join('\n');
}
