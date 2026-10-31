// Runs the contract suites with no test runner, so an installed Nightjar can check a repo's own Adapter.
import type { ContractCase } from './case.js';
import { codeHostContract } from './code-host.js';
import { trackerContract } from './tracker.js';

// A module exports the harnesses of the Adapters it wants checked.
export class ContractRefusal extends Error {}

export interface CaseResult {
	readonly name: string;
	readonly ok: boolean;
	// why it failed
	readonly error?: string;
}

export interface SuiteResult {
	readonly title: string;
	readonly results: readonly CaseResult[];
}

export interface Report {
	readonly suites: readonly SuiteResult[];
	readonly total: number;
	readonly failed: number;
}

async function runSuite<Harness>(
	title: string,
	cases: readonly ContractCase<Harness>[],
	harness: Harness
): Promise<SuiteResult> {
	const results: CaseResult[] = [];
	for (const c of cases) {
		try {
			await c.run(harness);
			results.push({ name: c.name, ok: true });
		} catch (fault) {
			results.push({
				name: c.name,
				ok: false,
				error: fault instanceof Error ? fault.message : String(fault)
			});
		}
	}
	return { title, results };
}

function harnessOf(exports: Record<string, unknown>, name: string): unknown {
	const found = exports[name];
	if (found !== undefined && typeof found !== 'function') {
		throw new ContractRefusal(`exports ${name}, which is not a function`);
	}
	return found;
}

// The suites over the `trackerHarness` and `codeHostHarness` a module exports.
export async function runContract(exports: Record<string, unknown>): Promise<Report> {
	const tracker = harnessOf(exports, 'trackerHarness');
	const codeHost = harnessOf(exports, 'codeHostHarness');
	if (tracker === undefined && codeHost === undefined) {
		throw new ContractRefusal('exports neither trackerHarness nor codeHostHarness');
	}
	const suites: SuiteResult[] = [];
	if (tracker !== undefined) {
		suites.push(await runSuite('Tracker', trackerContract, tracker as never));
	}
	if (codeHost !== undefined) {
		suites.push(await runSuite('Code host', codeHostContract, codeHost as never));
	}
	const all = suites.flatMap((s) => s.results);
	return { suites, total: all.length, failed: all.filter((r) => !r.ok).length };
}

const indent = (text: string, by: string) =>
	text
		.split('\n')
		.map((line) => `${by}${line}`.trimEnd())
		.join('\n');

export function formatReport(report: Report): string {
	const lines: string[] = [];
	for (const suite of report.suites) {
		lines.push(`${suite.title} contract`);
		for (const r of suite.results) {
			lines.push(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`);
			if (r.error !== undefined) lines.push(indent(r.error.trim(), '        '));
		}
		lines.push('');
	}
	lines.push(
		report.failed === 0
			? `All ${String(report.total)} behaviours pass.`
			: `${String(report.failed)} of ${String(report.total)} behaviours fail.`
	);
	return lines.join('\n');
}
