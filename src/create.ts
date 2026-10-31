// `nightjar create FILE`: makes a Feature and its Tickets from a Feature file on the Tracker
// factory.json names. The Tickets get the ready Signal; the Feature gets none, so nothing is built
// until a person gives it the Go.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeAdapters } from './adapters.js';
import { ticketLine } from './build.js';
import { ConfigError, loadConfig } from './config.js';
import { FeatureFileError, readFeatureFile, type FeaturePlan } from './feature-file.js';
import { run, type Env } from './git.js';
import type { FeatureWriter, ItemId, Tracker } from './tracker.js';
import { say, why } from './say.js';

export const CREATE_USAGE = `usage: nightjar create [--dry-run] FILE

  FILE       a Feature and its Tickets as Markdown, in the shape of docs/ticket-contract.md
  --dry-run  read the file and say what it would make, making nothing`;

export interface Made {
	readonly feature: ItemId;
	// in the file's order
	readonly tickets: readonly ItemId[];
}

const listed = (texts: readonly string[]) =>
	texts.length < 2 ? texts.join('') : `${texts.slice(0, -1).join(', ')} and ${texts.at(-1) ?? ''}`;

// Each Ticket is linked to its blockers before it is marked ready, so it is never ready half made.
export async function makeFeature(
	tracker: Tracker & FeatureWriter,
	plan: FeaturePlan,
	say: (line: string) => void
): Promise<Made> {
	const ref = (id: ItemId) => tracker.reference(id).text;
	const made: ItemId[] = [];
	try {
		const feature = await tracker.createFeature(plan.feature);
		made.push(feature);
		say(`made the Feature ${ref(feature)} ${plan.feature.title}`);
		const ids = new Map<number, ItemId>();
		for (const ticket of plan.tickets) {
			const id = await tracker.createTicket(feature, ticket);
			made.push(id);
			ids.set(ticket.number, id);
			const blockers = ticket.blockedBy.flatMap((n) => ids.get(n) ?? []);
			for (const blocker of blockers) await tracker.block(id, blocker);
			await tracker.addSignal(id, 'ready');
			const blocked = blockers.length === 0 ? '' : `, blocked by ${listed(blockers.map(ref))}`;
			say(`made Ticket ${String(ticket.number)} as ${ref(id)} ${ticket.title}${blocked}, ready`);
		}
		return { feature, tickets: made.slice(1) };
	} catch (fault) {
		const before = made.length === 0 ? 'nothing' : made.map(ref).join(', ');
		throw new Error(`${why(fault)}; made before it: ${before}. Nothing was undone.`, {
			cause: fault
		});
	}
}

const refuse = (text: string) => {
	console.error(`nightjar: ${text}`);
	return 2;
};

function dryRun(plan: FeaturePlan): void {
	say(`would make the Feature ${plan.feature.title}`);
	for (const t of plan.tickets) {
		const model = ticketLine(t.body, 'Model');
		const effort = ticketLine(t.body, 'Effort');
		const runs = [model && `on ${model}`, effort && `at ${effort}`].filter(Boolean).join(' ');
		const blockers = t.blockedBy.map((n) => `Ticket ${String(n)}`);
		const blocked = blockers.length === 0 ? '' : `, blocked by ${listed(blockers)}`;
		say(
			`would make Ticket ${String(t.number)} ${t.title}${blocked}${runs ? `, ${runs}` : ''}, ready`
		);
	}
}

// 0 when all is made, 1 when the Tracker failed part way, 2 when nothing was tried.
export async function runCreateCommand(argv: readonly string[]): Promise<number> {
	const dry = argv.includes('--dry-run');
	const rest = argv.filter((a) => a !== '--dry-run');
	const [path] = rest;
	if (path === undefined || rest.length > 1 || path.startsWith('-')) {
		const why = path === undefined ? 'say which file' : 'one file at a time';
		return refuse(`${why}\n\n${CREATE_USAGE}`);
	}
	let plan: FeaturePlan;
	try {
		plan = readFeatureFile(readFileSync(resolve(path), 'utf8'));
	} catch (fault) {
		if (!(fault instanceof FeatureFileError)) return refuse(`cannot read ${path}`);
		const lines = fault.message.split('\n').map((line) => `${path}: ${line}`);
		return refuse(lines.join('\nnightjar: '));
	}
	if (dry) {
		dryRun(plan);
		return 0;
	}
	const env: Env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
	const top = await run('git', ['rev-parse', '--show-toplevel'], process.cwd(), env);
	if (!top.ok) return refuse('not inside a git checkout');
	const root = top.out.trim();
	let writer: (Tracker & FeatureWriter) | string;
	let go: string;
	try {
		const config = loadConfig(root);
		go = config.signals.go;
		writer = (await makeAdapters(config, root, env)).writer;
	} catch (fault) {
		if (fault instanceof ConfigError) return refuse(fault.message);
		throw fault;
	}
	if (typeof writer === 'string') return refuse(writer);
	try {
		const made = await makeFeature(writer, plan, say);
		const ref = writer.reference(made.feature).text;
		say(`${ref} carries no Signal: assign it to yourself and give it the Go (${go}) to build it.`);
		return 0;
	} catch (fault) {
		console.error(`nightjar: ${why(fault)}`);
		return 1;
	}
}
