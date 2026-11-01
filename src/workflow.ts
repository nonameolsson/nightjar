// Workflows (GLOSSARY.md): which one a Feature picks, and what its Steps leave for the pull request.
import type { Config } from './config.js';
import type { ItemId } from './tracker.js';

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
