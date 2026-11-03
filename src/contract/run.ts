// Runs the contract suites with no test runner, so an installed Nightjar can check a repo's own Adapter.
import type { ContractCase } from './case.js';
import { codeHostContract, type CodeHostHarness, type CodeHostSubject } from './code-host.js';
import { feedbackContract } from './feedback.js';
import { canCreate } from '../tracker.js';
import { featureWriterContract } from './feature-writer.js';
import { trackerContract, type TrackerHarness, type TrackerSubject } from './tracker.js';
import { waitingOnContract } from './waiting-on.js';
import { why } from '../say.js';

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
				error: why(fault)
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

// What the Tracker can do beyond the interface's required methods. A harness that cannot build a Tracker over an empty world has failed every case already, so it is asked nothing more.
async function optionalSuites(
	harness: TrackerHarness
): Promise<{ creates: boolean; waitsOn: boolean }> {
	let subject: TrackerSubject;
	try {
		subject = await harness({ person: 'ann', trusted: ['ann'], items: [] });
	} catch {
		return { creates: false, waitsOn: false };
	}
	try {
		return {
			creates: canCreate(subject.tracker),
			waitsOn: typeof subject.tracker.waitingOn === 'function'
		};
	} finally {
		await subject.close?.();
	}
}

// Whether the Code host answers feedback. A harness that cannot make a Code host has failed every case already, so it is asked nothing more.
async function hasFeedback(harness: CodeHostHarness): Promise<boolean> {
	let subject: CodeHostSubject;
	try {
		subject = await harness();
	} catch {
		return false;
	}
	try {
		return (
			typeof subject.codeHost.feedback === 'function' &&
			typeof subject.codeHost.reply === 'function'
		);
	} finally {
		await subject.close?.();
	}
}

// The creation suite runs too when the Tracker makes Features, the waitingOn suite when it has waitingOn, and the feedback suite when the Code host has feedback and reply.
export async function runContract(exports: Record<string, unknown>): Promise<Report> {
	const tracker = harnessOf(exports, 'trackerHarness');
	const codeHost = harnessOf(exports, 'codeHostHarness');
	if (tracker === undefined && codeHost === undefined) {
		throw new ContractRefusal('exports neither trackerHarness nor codeHostHarness');
	}
	const suites: SuiteResult[] = [];
	if (tracker !== undefined) {
		suites.push(await runSuite('Tracker', trackerContract, tracker as never));
		const has = await optionalSuites(tracker as TrackerHarness);
		if (has.creates) {
			suites.push(await runSuite('Tracker creation', featureWriterContract, tracker as never));
		}
		if (has.waitsOn) {
			suites.push(await runSuite('Tracker waiting on', waitingOnContract, tracker as never));
		}
	}
	if (codeHost !== undefined) {
		suites.push(await runSuite('Code host', codeHostContract, codeHost as never));
		if (await hasFeedback(codeHost as CodeHostHarness)) {
			suites.push(await runSuite('Code host feedback', feedbackContract, codeHost as never));
		}
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
