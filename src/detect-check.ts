// Guesses of the check command, read from the files a repo already has; each says where it came from.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Detected {
	readonly command: string;
	readonly source: string;
}

function read(root: string, ...path: string[]): string | null {
	try {
		return readFileSync(join(root, ...path), 'utf8');
	} catch {
		return null;
	}
}

function packageManager(root: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
	const has = (f: string) => existsSync(join(root, f));
	if (has('pnpm-lock.yaml')) return 'pnpm';
	if (has('yarn.lock')) return 'yarn';
	if (has('bun.lock') || has('bun.lockb')) return 'bun';
	return 'npm';
}

function fromPackageJson(root: string): Detected[] {
	const text = read(root, 'package.json');
	if (text === null) return [];
	let scripts: unknown;
	try {
		scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
	} catch {
		return [];
	}
	if (typeof scripts !== 'object' || scripts === null) return [];
	const pm = packageManager(root);
	const found: Detected[] = [];
	if ('check' in scripts)
		found.push({ command: `${pm} run check`, source: 'package.json "check"' });
	if ('test' in scripts) found.push({ command: `${pm} test`, source: 'package.json "test"' });
	return found;
}

function fromTargets(
	root: string,
	file: string,
	pattern: (name: string) => RegExp,
	command: (name: string) => string
): Detected[] {
	const text = read(root, file);
	if (text === null) return [];
	return ['check', 'test']
		.filter((name) => pattern(name).test(text))
		.map((name) => ({ command: command(name), source: `${file} "${name}"` }));
}

function fromWorkflows(root: string): Detected[] {
	let names: string[];
	try {
		names = readdirSync(join(root, '.github', 'workflows')).filter((n) => /\.ya?ml$/.test(n));
	} catch {
		return [];
	}
	const found: Detected[] = [];
	for (const name of names.sort()) {
		const text = read(root, '.github', 'workflows', name) ?? '';
		for (const line of text.split('\n')) {
			const run = /^\s*(?:-\s+)?run:\s*(.+?)\s*$/.exec(line)?.[1];
			if (
				run !== undefined &&
				/^(npm|pnpm|yarn|bun|make|just|cargo|go|pytest|deno)\b.*\b(test|check)\b/.test(run)
			)
				found.push({ command: run, source: `.github/workflows/${name}` });
		}
	}
	return found;
}

function fromScripts(root: string): Detected[] {
	try {
		return readdirSync(root)
			.filter((n) => n.endsWith('.test.sh'))
			.sort()
			.map((n) => ({ command: `sh ${n}`, source: n }));
	} catch {
		return [];
	}
}

function fromDeno(root: string): Detected[] {
	const file = existsSync(join(root, 'deno.json')) ? 'deno.json' : 'deno.jsonc';
	const text = read(root, file);
	if (text === null) return [];
	return [
		/"test"\s*:/.test(text)
			? { command: 'deno task test', source: `${file} "test"` }
			: { command: 'deno test', source: file }
	];
}

// The test, lint and build commands the repo's package.json, Makefile and justfile name.
export function detectTools(root: string): Detected[] {
	const names = ['test', 'lint', 'build'];
	const found: Detected[] = [];
	const text = read(root, 'package.json');
	let scripts: object | null = null;
	try {
		const parsed = (JSON.parse(text ?? 'null') as { scripts?: unknown } | null)?.scripts;
		if (typeof parsed === 'object' && parsed !== null) scripts = parsed;
	} catch {
		scripts = null;
	}
	if (scripts !== null) {
		const pm = packageManager(root);
		for (const n of names)
			if (n in scripts)
				found.push({
					command: n === 'test' ? `${pm} test` : `${pm} run ${n}`,
					source: `package.json "${n}"`
				});
	}
	for (const [file, tool] of [
		['Makefile', 'make'],
		['justfile', 'just'],
		['Justfile', 'just']
	] as const) {
		const body = read(root, file);
		if (body === null) continue;
		for (const n of names)
			if (new RegExp(`^${n}\\s*:`, 'm').test(body))
				found.push({ command: `${tool} ${n}`, source: `${file} "${n}"` });
	}
	return found;
}

// Every distinct command the repo's files suggest, the likeliest first.
export function detectChecks(root: string): Detected[] {
	const exists = (f: string) => existsSync(join(root, f));
	const all: Detected[] = [
		...fromTargets(
			root,
			'Makefile',
			(n) => new RegExp(`^${n}\\s*:`, 'm'),
			(n) => `make ${n}`
		),
		...fromPackageJson(root),
		...(exists('pyproject.toml') ? [{ command: 'pytest', source: 'pyproject.toml' }] : []),
		...(exists('Cargo.toml') ? [{ command: 'cargo test', source: 'Cargo.toml' }] : []),
		...(exists('go.mod') ? [{ command: 'go test ./...', source: 'go.mod' }] : []),
		...['justfile', 'Justfile'].flatMap((f) =>
			exists(f)
				? fromTargets(
						root,
						f,
						(n) => new RegExp(`^${n}\\s*:`, 'm'),
						(n) => `just ${n}`
					)
				: []
		),
		...['mise.toml', '.mise.toml'].flatMap((f) =>
			exists(f)
				? fromTargets(
						root,
						f,
						(n) => new RegExp(`^\\[tasks\\.${n}\\]`, 'm'),
						(n) => `mise run ${n}`
					)
				: []
		),
		...(exists('deno.json') || exists('deno.jsonc') ? fromDeno(root) : []),
		...fromWorkflows(root),
		...fromScripts(root)
	];
	const seen = new Set<string>();
	return all.filter((d) => !seen.has(d.command) && seen.add(d.command));
}
