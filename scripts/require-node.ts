// Vitest's global setup: stops once, in words, when Node is older than package.json's `engines` asks, rather than as dozens of unrelated spec failures.
import { readFileSync } from 'node:fs';

export default function setup(): void {
	const { engines } = JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8')
	) as { engines: { node: string } };
	const needed = Number(/\d+/.exec(engines.node)?.[0]);
	const have = Number(process.versions.node.split('.')[0]);
	if (have >= needed) return;
	// printed and exited, not thrown: Vitest crashes printing a setup error's stack, and the words are lost
	console.error(
		`Node ${String(needed)} or later is needed, and this is ${process.versions.node}. Run \`mise trust && mise install\`, then try again.`
	);
	process.exit(1);
}
