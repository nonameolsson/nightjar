// Fails when a file of the repo or of the packed package holds a guarded name (scripts/leak-names.ts).
// Run: npx tsx scripts/leak-check.ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GUARDED } from './leak-names.js';

export interface Source {
	readonly path: string;
	readonly text: string;
}
export interface Leak {
	readonly path: string;
	// 0 for the path itself
	readonly line: number;
}

const sha = (word: string) => createHash('sha256').update(word).digest('hex');

// whole lowercase words, and the parts of a camelCase one
function words(text: string): string[] {
	const lower = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	const camel = text.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? [];
	return [...lower, ...camel.map((w) => w.toLowerCase())];
}

const hits = (text: string, guard: ReadonlySet<string>) =>
	words(text).some((w) => guard.has(sha(w)));

// Reports where, never what: the word is not repeated.
export function leaks(files: readonly Source[], guard: ReadonlySet<string> = GUARDED): Leak[] {
	const found: Leak[] = [];
	for (const { path, text } of files) {
		if (hits(path, guard)) found.push({ path, line: 0 });
		text.split('\n').forEach((line, i) => {
			if (hits(line, guard)) found.push({ path, line: i + 1 });
		});
	}
	return found;
}

function read(paths: readonly string[]): Source[] {
	const files: Source[] = [];
	for (const path of paths) {
		try {
			const text = readFileSync(path, 'utf8');
			if (!text.includes('\0')) files.push({ path, text });
		} catch {
			// deleted since the listing, or a directory
		}
	}
	return files;
}

// every file git knows or would add, so a new file is checked before it is committed
export function repoFiles(): Source[] {
	const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
		encoding: 'utf8'
	});
	return read(out.split('\0').filter(Boolean));
}

// the files `npm pack` would put in the tarball
export function packedFiles(): Source[] {
	const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	});
	const [pack] = JSON.parse(out) as { files: { path: string }[] }[];
	return read((pack?.files ?? []).map((f) => f.path));
}

if (import.meta.filename === process.argv[1]) {
	const found = [...leaks(repoFiles()), ...leaks(packedFiles())];
	for (const f of found) console.error(`guarded name: ${f.path}:${String(f.line)}`);
	if (found.length > 0) process.exit(1);
	console.log('leak check: clean');
}
