// `nightjar retro [--create]`: one read-only Session reads the Sessions that failed or were handed back, and proposes changes to the repo's own guidance as a Feature file.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Args } from './args.js';
import { LIMITS } from './build.js';
import type { Ready } from './checks.js';
import { codingAgent, logsPath, type CodingAgent, type RetroOutcome } from './coding-agent.js';
import { makeFeature } from './create.js';
import { FeatureFileError, readFeatureFile, type FeaturePlan } from './feature-file.js';
import { fileSpend, ledgerPath } from './ledger.js';
import { isSessionId } from './logbook-reader.js';
import { MEASURE_DAYS } from './measures.js';
import type { RetroFailure } from './prompt.js';
import { say, why } from './say.js';
import { runSession } from './session.js';
import { renderSession } from './session-render.js';
import type { Entry, LogEntry, Spend } from './spend.js';
import type { FeatureWriter, Tracker } from './tracker.js';

// One Session, capped at the review's limits.
export const RETRO_USD = LIMITS.reviewUsd;
export const RETRO_MINUTES = LIMITS.reviewMinutes;
export const RETRO_DAYS = MEASURE_DAYS;

// The most failed Sessions the prompt lists, the latest; the Session finds the others in the ledger.
const MAX_FAILURES = 20;
// What of each transcript the prompt holds: its last rendered lines (the agent's text, its tool calls and their results), each cut to LINE_CHARS, and all cut to TAIL_CHARS.
const TAIL_LINES = 30;
const LINE_CHARS = 400;
const TAIL_CHARS = 3000;
const DAY_MS = 86_400_000;

export const plansPath = (root: string) => join(root, '.factory', 'plans');

// A Session that failed, or handed its work back to a person: it asked questions, gave up or reported itself blocked.
// A pause and a person's stop are neither, and a Retro never reads another Retro.
export function isFailure(e: Entry): boolean {
	if (e.step === 'retro' || e.outcome.includes('stopped by a person')) return false;
	if (e.failure !== undefined) return true;
	return /\bfailed\b|\bgave up\b|\bblocked\b|^questions\b/.test(e.outcome);
}

// The failed and handed-back Sessions of the RETRO_DAYS up to `now`, oldest first.
export function failuresIn(entries: readonly Entry[], now: Date): Entry[] {
	const since = now.getTime() - RETRO_DAYS * DAY_MS;
	return entries.filter((e) => {
		const at = Date.parse(e.at);
		return at > since && at <= now.getTime() && isFailure(e);
	});
}

// The end of a Session's transcript as the views render it in full; empty when it has none on this machine.
function tailOf(root: string, session: string): string {
	if (!isSessionId(session)) return '';
	let text: string;
	try {
		text = readFileSync(join(logsPath(root), `${session}.jsonl`), 'utf8');
	} catch {
		return '';
	}
	const lines = renderSession(text.split('\n'), 'full')
		.slice(-TAIL_LINES)
		.map((l) => (l.text.length > LINE_CHARS ? `${l.text.slice(0, LINE_CHARS - 1)}…` : l.text))
		.join('\n');
	return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
}

export const failureOf = (root: string, e: Entry): RetroFailure => ({
	session: e.session,
	at: e.at,
	feature: e.feature,
	ticket: e.ticket,
	step: e.step,
	outcome: e.outcome,
	costUsd: e.costUsd,
	transcript: `.factory/logs/${e.session}.jsonl`,
	tail: tailOf(root, e.session)
});

const pad = (n: number) => String(n).padStart(2, '0');

// .factory/plans/retro-<local date>.md, from the repo's root; a later Retro on the same day gets -2, -3, so a file a person may have edited is never written over.
export function retroFile(root: string, now: Date): string {
	const day = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	for (let n = 1; ; n += 1) {
		const name = `.factory/plans/retro-${day}${n === 1 ? '' : `-${String(n)}`}.md`;
		if (!existsSync(join(root, name))) return name;
	}
}

// How the Session ended, in the ledger's words.
function ledgerLine(got: RetroOutcome): Pick<LogEntry, 'outcome' | 'failure'> {
	switch (got.kind) {
		case 'proposed':
			return { outcome: 'proposed' };
		case 'nothing':
			return { outcome: 'nothing to propose' };
		case 'failed':
			return { outcome: `failed: ${got.why}`, failure: got.failure };
		case 'paused':
			return { outcome: `paused: ${got.why}` };
		case 'aborted':
			return { outcome: 'stopped by a person' };
	}
}

export interface RetroDeps {
	readonly root: string;
	readonly repo: string;
	readonly agent: Pick<CodingAgent, 'retro'>;
	// the ledger: what the Retro reads, where its Session's cost is recorded, and the day's spend
	readonly spend: Spend;
	readonly dailyUsd: number;
	readonly now: () => Date;
	readonly newId: () => string;
	readonly say: (line: string) => void;
	readonly error: (line: string) => void;
	// with --create: the Tracker that makes the Feature, and the Go's name, for the line that says how to build it
	readonly create?: { readonly writer: Tracker & FeatureWriter; readonly go: string };
}

// 0 when the Feature file is written (and made, with --create) or there is nothing to read or propose; 1 when the day's limit, the Session, its answer or the Tracker stops it.
export async function runRetro(d: RetroDeps): Promise<number> {
	const now = d.now();
	const failed = failuresIn(d.spend.entries(), now);
	if (failed.length === 0) {
		d.say(
			`no Session failed or was handed back in the last ${String(RETRO_DAYS)} days, so the retro has nothing to read and started no Session`
		);
		return 0;
	}
	const over = d.spend.dayOver(now, d.dailyUsd);
	if (over !== null) {
		d.error(`no retro: ${over}`);
		return 1;
	}
	const left = d.spend.allowance(d.dailyUsd, d.spend.today(now));
	if (!left.enough) {
		d.error(
			`no retro: $${left.usd.toFixed(2)} is left of the daily limit of $${d.dailyUsd.toFixed(2)}, too little for a Session`
		);
		return 1;
	}
	const budgetUsd = Math.min(RETRO_USD, left.usd);
	const listed = failed.slice(-MAX_FAILURES);
	d.say(
		`reading ${String(failed.length)} failed or handed-back Sessions of the last ${String(RETRO_DAYS)} days in one read-only Session, at most $${budgetUsd.toFixed(2)} and ${String(RETRO_MINUTES)} minutes`
	);
	const sessionId = d.newId();
	const got = await d.agent.retro({
		kind: 'retro',
		sessionId,
		folder: d.root,
		budgetUsd,
		minutes: RETRO_MINUTES,
		days: RETRO_DAYS,
		failures: listed.map((e) => failureOf(d.root, e)),
		more: failed.length - listed.length
	});
	const end = d.now();
	d.spend.record({
		at: end.toISOString(),
		repo: d.repo,
		feature: '',
		ticket: null,
		branch: '',
		step: 'retro',
		session: got.sessionId,
		costUsd: got.costUsd,
		...ledgerLine(got),
		durationMs: Math.max(0, end.getTime() - now.getTime())
	});
	if (got.kind === 'failed' || got.kind === 'paused') {
		d.error(`the retro's Session ${got.kind === 'failed' ? 'failed' : 'paused'}: ${got.why}`);
		return 1;
	}
	if (got.kind === 'aborted') {
		d.error("the retro's Session was stopped");
		return 1;
	}
	if (got.kind === 'nothing') {
		d.say(`the retro proposes no change: ${got.summary}`);
		return 0;
	}
	return written(d, got.featureFile, now);
}

// Writes the Session's Feature file, checks it as `nightjar create` would, and makes it with --create.
async function written(d: RetroDeps, text: string, now: Date): Promise<number> {
	const file = retroFile(d.root, now);
	let plan: FeaturePlan | null = null;
	let faults: string[] = [];
	try {
		plan = readFeatureFile(text);
	} catch (fault) {
		if (!(fault instanceof FeatureFileError)) throw fault;
		faults = fault.message.split('\n');
	}
	mkdirSync(plansPath(d.root), { recursive: true });
	writeFileSync(join(d.root, file), text.endsWith('\n') ? text : `${text}\n`);
	if (plan === null) {
		d.error(`wrote ${file}, but nightjar create would refuse it:`);
		for (const line of faults) d.error(`${file}: ${line}`);
		return 1;
	}
	const tickets = plan.tickets.length;
	d.say(
		`wrote ${file}: ${plan.feature.title}, ${String(tickets)} Ticket${tickets === 1 ? '' : 's'}`
	);
	if (d.create === undefined) {
		d.say(`read it, then make it with: nightjar create ${file}`);
		return 0;
	}
	const { writer, go } = d.create;
	try {
		const made = await makeFeature(writer, plan, d.say);
		const ref = writer.reference(made.feature).text;
		d.say(
			`${ref} carries no Signal: assign it to yourself and give it the Go (${go}) to build it.`
		);
		return 0;
	} catch (fault) {
		d.error(why(fault));
		return 1;
	}
}

// The command, after the machine's checks a build runs: one Session on the run's login, model and effort, stopped by Ctrl-C.
export async function runRetroCommand(args: Args, ready: Ready): Promise<number> {
	const { root, config, adapters } = ready;
	const error = (line: string) => console.error(`nightjar: ${line}`);
	let create: RetroDeps['create'];
	if (args.create === true) {
		// refused before the Session, which would spend for nothing
		if (typeof adapters.writer === 'string') {
			error(adapters.writer);
			return 2;
		}
		create = { writer: adapters.writer, go: config.signals.go };
	}
	const stop = new AbortController();
	const abort = () => stop.abort();
	process.once('SIGINT', abort);
	process.once('SIGTERM', abort);
	const agent = codingAgent(
		{
			root,
			check: config.check,
			allowedCommands: config.allowedCommands,
			allowApiKey: args.useApiKey,
			env: ready.env,
			...(args.model === undefined ? {} : { model: args.model }),
			...(args.effort === undefined ? {} : { effort: args.effort }),
			defaults: { model: config.model, effort: config.effort },
			limits: LIMITS,
			signal: stop.signal
		},
		(req) => runSession(req)
	);
	try {
		return await runRetro({
			root,
			repo: adapters.repo,
			agent,
			spend: fileSpend(ledgerPath(root)),
			dailyUsd: ready.person.dailyUsd,
			now: () => new Date(),
			newId: () => randomUUID(),
			say,
			error,
			...(create === undefined ? {} : { create })
		});
	} finally {
		process.off('SIGINT', abort);
		process.off('SIGTERM', abort);
	}
}
