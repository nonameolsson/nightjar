// Workflows (GLOSSARY.md): which one a Feature picks, how its Steps run, and what they leave for the pull request.
import type { CheckResult, RunCheck } from './check.js';
import { envOf, type CodingAgent, type Ended, type Fixing } from './coding-agent.js';
import { DEFAULT_ROUNDS, type Config } from './config.js';
import type { Env } from './git.js';
import type { Allowance, Entry } from './spend.js';
import type { Serve, Served } from './serve.js';
import type { Feature, ItemId, Ticket } from './tracker.js';
import type { Worktree } from './worktree.js';

export type WorkflowConfig = NonNullable<Config['workflows']>[string];
export type StepConfig = WorkflowConfig['steps'][number];
export type StepPoint = StepConfig['point'];

// A Feature's own `**Workflow:**` line, as written; the bold is optional.
export function workflowLine(body: string): string | undefined {
	const match = /^(?:\*\*)?Workflow:(?:\*\*)?[ \t]*([^*\s].*?)\s*$/im.exec(body);
	return match?.[1]?.replace(/^`(.*)`$/, '$1').trim() || undefined;
}

export type Chosen =
	| { readonly kind: 'none' }
	| { readonly kind: 'workflow'; readonly name: string; readonly workflow: WorkflowConfig }
	// the Feature cannot be built; `why` is said on it
	| { readonly kind: 'refused'; readonly why: string };

export interface WorkflowSettings {
	readonly workflows?: Readonly<Record<string, WorkflowConfig>>;
	readonly defaultWorkflow?: string;
	// Workflows that cannot run on this machine, by name, with the reason
	readonly brokenWorkflows?: Readonly<Record<string, string>>;
}

export function chooseWorkflow(settings: WorkflowSettings, body: string): Chosen {
	const known = Object.keys(settings.workflows ?? {});
	const asked = workflowLine(body);
	const name =
		asked === undefined
			? settings.defaultWorkflow
			: (known.find((n) => n === asked) ??
				known.find((n) => n.toLowerCase() === asked.toLowerCase()));
	if (asked === undefined && name === undefined) return { kind: 'none' };
	const workflow = name === undefined ? undefined : settings.workflows?.[name];
	if (name === undefined || workflow === undefined) {
		const list =
			known.length === 0 ? 'factory.json names none' : known.map((n) => `\`${n}\``).join(', ');
		return {
			kind: 'refused',
			why: `its \`**Workflow:**\` line names \`${asked ?? ''}\`, which is no Workflow. The Workflows known: ${list}.`
		};
	}
	const broken = settings.brokenWorkflows?.[name];
	if (broken !== undefined) {
		return { kind: 'refused', why: `the Workflow \`${name}\` cannot run: ${broken}` };
	}
	return { kind: 'workflow', name, workflow };
}

// What a Step is called in a commit trailer, which tells a later run it is done.
export const stepKey = (workflow: string, step: string, ticket: ItemId | null) =>
	`${workflow}/${step}${ticket === null ? '' : ` #${ticket}`}`;

// The skills a Step's prompt names with a slash, such as `/some-skill args`.
export function skillsNamed(prompt: string): string[] {
	const names = [
		...prompt.matchAll(/(?<![\w/.:~-])\/([a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)?)(?![\w/.-])/g)
	];
	return [...new Set(names.flatMap((m) => (m[1] ? [m[1]] : [])))];
}

export interface StepReport {
	readonly step: StepConfig;
	// the Ticket an afterEachTicket Step ran after
	readonly ticket: ItemId | null;
	// unmet: it ran every round and its `until` still did not hold
	readonly state: 'done' | 'unmet' | 'undone';
	readonly why?: string;
	readonly rounds?: number;
	readonly left: readonly string[];
}

// The pull request's section on a Workflow, or null when it ran no Step.
export function workflowSection(
	name: string,
	reports: readonly StepReport[],
	ref: (id: ItemId) => string
): string | null {
	if (reports.length === 0) return null;
	const lines = reports.map((r) => {
		const where = `\`${r.step.name}\`${r.ticket === null ? '' : ` (after ${ref(r.ticket)})`}`;
		if (r.state === 'done') return `- ${where}: done`;
		if (r.state === 'undone')
			return `- ${where}: **not done**, ${r.why ?? 'it did not finish'}; its changes were thrown away`;
		const left = r.left.map((l) => `\n  - ${l}`).join('');
		return `- ${where}: its condition (${r.step.until ?? ''}) did not hold after ${String(r.rounds ?? 0)} round${r.rounds === 1 ? '' : 's'}. Left:${left || ' (it listed nothing)'}`;
	});
	return `## Workflow \`${name}\`\n\n${lines.join('\n')}`;
}

// What ends a piece of work before its own end: the run goes on later, or a person stopped it.
export type Halt = Extract<Ended, { kind: 'paused' | 'aborted' }>;

// How the Steps at one point ended: the run goes on, or it halts.
export type StepsEnd = { readonly kind: 'next' } | Halt;

const NEXT: StepsEnd = { kind: 'next' };

// The fix rounds the build loop gives a Ticket, given a Step too: what to fix.
export interface FixWork {
	readonly ticket: ItemId | null;
	// what the run says it is fixing
	readonly name: string;
	readonly sessionId: string;
	// the most the whole piece of work may cost
	readonly cap: number;
	readonly spent: number;
	readonly check: CheckResult;
	readonly of: Fixing;
	// when the whole piece of work must stop, in epoch milliseconds; left out, only each Session's own minutes hold
	readonly deadline?: number;
}

// How the fix rounds ended: the last check, what the work has spent, and each round's summary.
export interface FixEnd {
	readonly check: CheckResult;
	readonly spent: number;
	readonly summaries: readonly string[];
	readonly halt?: Halt;
}

// A Step's ledger line, which the build loop dates and files under the Feature.
export type StepLog = Omit<Entry, 'at' | 'repo' | 'feature' | 'branch'>;

// What of the Feature's worktree the Steps use.
export type StepsTree = Pick<
	Worktree,
	'at' | 'head' | 'notes' | 'diff' | 'stepsDone' | 'commitStep' | 'revert'
>;

export interface StepsSetup {
	readonly check: string;
	readonly env: Env;
	// the reserved ports; the serve command listens on the first
	readonly portEnv?: Readonly<Record<string, string>>;
	// a Step without its own budget runs on a Ticket's
	readonly limits: { readonly ticketUsd: number };
}

// What the build loop lends a Workflow's Steps.
export interface StepsRun {
	readonly codingAgent: Pick<CodingAgent, 'step'>;
	readonly runCheck: RunCheck;
	readonly serve: Serve;
	readonly newId: () => string;
	readonly say: (line: string) => void;
	readonly setup: StepsSetup;
	readonly feature: Feature;
	readonly tree: StepsTree;
	readonly fix: (work: FixWork) => Promise<FixEnd>;
	readonly log: (entry: StepLog) => void;
	// tells the status file a Step's round has started
	readonly building: (
		ticket: ItemId | null,
		session: string,
		rounds: { readonly round: number; readonly rounds: number }
	) => void;
	// why the run pauses before another Session, else null
	readonly dailyPause: () => string | null;
	// what a piece of work that has spent `spent` of its `cap` may still spend
	readonly allowance: (cap: number, spent: number) => Allowance;
	readonly aborted: () => boolean;
}

// A Step thrown away, and why.
interface Undone {
	readonly kind: 'undone';
	readonly why: string;
}

// How one Step of a Workflow ended.
type StepEnd = { readonly kind: 'done' } | Undone | Halt;

// The most of a Feature's diff a Step's or a fresh Pull-check fix's prompt carries; the rest is in git.
export const DIFF_CHARS = 60_000;

// One Feature's Workflow, with the Steps its branch holds already, by their trailers.
export async function openWorkflow(
	chosen: { readonly name: string; readonly workflow: WorkflowConfig },
	run: StepsRun
): Promise<WorkflowRun> {
	return new WorkflowRun(chosen.name, chosen.workflow, run, await run.tree.stepsDone());
}

export class WorkflowRun {
	private readonly kept: StepReport[] = [];

	constructor(
		readonly name: string,
		private readonly workflow: WorkflowConfig,
		private readonly run: StepsRun,
		private readonly done: Set<string>
	) {}

	// The Workflow's Steps at one point, in order; a Step that fails is thrown away and the next still runs.
	async runAt(point: StepPoint, ticket: Ticket | null): Promise<StepsEnd> {
		const { run } = this;
		const key = (s: StepConfig) => stepKey(this.name, s.name, ticket?.id ?? null);
		const todo = this.workflow.steps.filter((s) => s.point === point && !this.done.has(key(s)));
		if (todo.length === 0) return NEXT;
		const served = await this.serve();
		try {
			for (const step of todo) {
				if (run.aborted()) return { kind: 'aborted' };
				const paused = run.dailyPause();
				if (paused !== null) return { kind: 'paused', why: paused };
				const end: StepEnd = served.ok
					? await this.runStep(step, ticket)
					: { kind: 'undone', why: `its serve command failed: ${served.tail}` };
				if (end.kind === 'paused' || end.kind === 'aborted') return end;
				if (end.kind === 'undone') {
					this.kept.push({
						step,
						ticket: ticket?.id ?? null,
						state: 'undone',
						why: end.why,
						left: []
					});
					run.say(`${this.name}/${step.name}: not done, ${end.why}`);
				}
			}
			return NEXT;
		} finally {
			if (served.ok) await served.stop();
		}
	}

	// What the Steps did, from this run and from the branch's commits, for the Tickets `built`; a Step that did not run is listed too.
	reports(built: readonly ItemId[]): StepReport[] {
		const reports = [...this.kept];
		const seen = (step: StepConfig, ticket: ItemId | null) =>
			reports.some((r) => r.step === step && r.ticket === ticket);
		const pairs = this.workflow.steps.flatMap((step): [StepConfig, ItemId | null][] =>
			step.point === 'afterEachTicket' ? built.map((id) => [step, id]) : [[step, null]]
		);
		for (const [step, ticket] of pairs) {
			if (seen(step, ticket)) continue;
			if (this.done.has(stepKey(this.name, step.name, ticket))) {
				reports.push({ step, ticket, state: 'done', left: [] });
			} else if (step.point === 'afterAllTickets') {
				const why = 'it did not run, as the Feature is not complete';
				reports.push({ step, ticket, state: 'undone', why, left: [] });
			}
		}
		const order = (r: StepReport) => this.workflow.steps.indexOf(r.step);
		return reports.sort((a, b) => order(a) - order(b));
	}

	// The pull request's section on the Workflow, or null when it ran no Step.
	section(built: readonly ItemId[], ref: (id: ItemId) => string): string | null {
		return workflowSection(this.name, this.reports(built), ref);
	}

	private async serve(): Promise<Served> {
		const { run } = this;
		const command = this.workflow.serve;
		if (command === undefined) return { ok: true, stop: () => Promise.resolve() };
		const first = Number(Object.values(run.setup.portEnv ?? {})[0]);
		run.say(`#${run.feature.id}: serving ${command}`);
		return run.serve(
			command,
			run.tree.at.folder,
			envOf(run.setup),
			Number.isInteger(first) ? first : null
		);
	}

	// One Step: its rounds, the check and fix rounds after each, and its own commit.
	private async runStep(step: StepConfig, ticket: Ticket | null): Promise<StepEnd> {
		const { run, name, workflow } = this;
		const { tree, setup } = run;
		const after = ticket?.id ?? null;
		const key = stepKey(name, step.name, after);
		const label = `${name}/${step.name}`;
		const before = await tree.head();
		const sessionId = run.newId();
		const rounds = step.until === undefined ? 1 : (step.maxRounds ?? DEFAULT_ROUNDS);
		const cap = step.budgetUsd ?? setup.limits.ticketUsd;
		const notes = await tree.notes();
		const diff = step.point === 'afterAllTickets' ? await tree.diff(DIFF_CHARS) : undefined;
		const extras = {
			allowedCommands: workflow.allowedCommands,
			allowedTools: workflow.allowedTools,
			localNetwork: workflow.localNetwork
		};
		const giveUp = async (why: string): Promise<StepEnd> => {
			await tree.revert(before);
			return { kind: 'undone', why };
		};
		run.say(`${label}: session ${sessionId}`);

		const summaries: string[] = [];
		let spent = 0;
		let left: readonly string[] = [];
		let holds = step.until === undefined;
		let ran = 0;
		for (let round = 1; round <= rounds && !(round > 1 && holds); round += 1) {
			const { usd: budget, enough } = run.allowance(cap, spent);
			if (round > 1 && !enough) break;
			run.building(after, sessionId, { round, rounds });
			const got = await run.codingAgent.step({
				kind: 'step',
				at: tree.at,
				sessionId,
				workflow: name,
				step,
				extras,
				round,
				rounds,
				feature: run.feature,
				ticket,
				notes,
				...(diff === undefined ? {} : { diff }),
				left,
				budgetUsd: budget
			});
			ran = round;
			spent += got.costUsd;
			const entry = {
				ticket: after,
				step: 'step' as const,
				session: sessionId,
				costUsd: got.costUsd
			};
			switch (got.kind) {
				case 'aborted':
					run.log({ ...entry, outcome: `${label}: stopped by a person` });
					await tree.revert(before);
					return { kind: 'aborted' };
				case 'paused':
					await tree.revert(before);
					run.log({ ...entry, outcome: `${label}: paused: ${got.why}` });
					return { kind: 'paused', why: got.why };
				case 'failed':
					run.log({ ...entry, outcome: `${label}: failed: ${got.why}`, failure: got.failure });
					return giveUp(got.why);
				case 'blocked':
					run.log({ ...entry, outcome: `${label}: blocked` });
					return giveUp(`it reported itself blocked${got.blocker ? `: ${got.blocker}` : ''}`);
				case 'done':
					break;
			}
			run.log({ ...entry, outcome: `${label}: round ${String(round)}` });
			summaries.push(got.summary);
			const checked = await run.fix({
				ticket: after,
				name: label,
				sessionId,
				cap,
				spent,
				check: await run.runCheck(setup.check, tree.at.folder, envOf(setup)),
				of: { kind: 'step', step, extras }
			});
			spent = checked.spent;
			summaries.push(...checked.summaries);
			if (checked.halt !== undefined) {
				await tree.revert(before);
				return checked.halt;
			}
			if (!checked.check.ok) return giveUp('its changes leave the check failing');
			left = got.left;
			holds = got.untilHolds;
		}
		await tree.commitStep({
			workflow: name,
			step: step.name,
			key,
			after,
			summary: summaries.join('\n\n'),
			session: sessionId
		});
		this.done.add(key);
		this.kept.push({
			step,
			ticket: after,
			state: holds ? 'done' : 'unmet',
			rounds: ran,
			left: holds ? [] : left
		});
		return { kind: 'done' };
	}
}
