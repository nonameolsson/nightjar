// The install commands that cannot fetch anything in a sandboxed Session, so they belong in `setup`.
const INSTALLS: readonly (readonly string[])[] = [
	['npm', 'install'],
	['npm', 'ci'],
	['pnpm', 'install'],
	['bun', 'install'],
	['pip', 'install'],
	['uv', 'sync'],
	['uv', 'pip'],
	['poetry', 'install'],
	['bundle', 'install'],
	['go', 'mod', 'download'],
	['cargo', 'fetch'],
	['composer', 'install']
];

// flags that make `yarn` say something about itself instead of installing
const YARN_LOOK_ALIKES = ['--version', '-v', '--help', '-h'];

// `yarn` alone installs, and so does `yarn` with install flags; `yarn test` runs a script
function yarnInstalls(args: readonly string[]): boolean {
	const first = args[0];
	if (first === undefined || first === 'install') return true;
	return first.startsWith('-') && !args.some((arg) => YARN_LOOK_ALIKES.includes(arg));
}

// Whether an allowedCommands pattern runs an install command, bare or with arguments.
export function installs(pattern: string): boolean {
	// the legacy `npm install:*` spells the same as `npm install *`
	const words = pattern.trim().replace(/:\*$/, ' *').split(/\s+/);
	if (words[0] === 'yarn') return yarnInstalls(words.slice(1));
	return INSTALLS.some((install) => install.every((word, i) => words[i] === word));
}
