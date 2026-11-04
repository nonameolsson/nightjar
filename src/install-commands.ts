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

// `yarn` alone installs, and so does `yarn` with only flags; `yarn test` runs a script
function yarnInstalls(args: readonly string[]): boolean {
	const first = args[0];
	return first === undefined || first === 'install' || first.startsWith('-');
}

// The install command an allowedCommands pattern runs, bare or with arguments; null for any other.
export function installCommand(pattern: string): string | null {
	// the legacy `npm install:*` spells the same as `npm install *`
	const words = pattern.trim().replace(/:\*$/, ' *').split(/\s+/);
	if (words[0] === 'yarn') return yarnInstalls(words.slice(1)) ? 'yarn' : null;
	const found = INSTALLS.find((install) => install.every((word, i) => words[i] === word));
	return found === undefined ? null : found.join(' ');
}
