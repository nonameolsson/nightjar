// Runs checks in their order: each needs facts the checks before it found, and fail-fast stops at the first that fails.
import { why } from './say.js';

export interface Line {
	readonly name: string;
	readonly status: 'ok' | 'fail' | 'skip' | 'warn';
	// what was found, or why it failed and how to fix it
	readonly detail: string;
	// the check as the one-line `checked:` of a build names it; none when it is left out
	readonly summary: string | null;
	// the one Workflow this line is an error for; it stops no other Workflow and no build of its own
	readonly only?: string;
	// the one Source this line is about; a fault in it stops no build, which never reads a Source
	readonly source?: string;
}

// What a check that passed found, and what it says.
export interface Passed<F> {
	// facts for the checks after it
	readonly found?: Partial<F>;
	// what its `ok` line says; left out, it says no line of its own
	readonly detail?: string;
	// how a build's `checked:` names it: left out it is the detail, and null leaves it out
	readonly summary?: string | null;
	// lines it says beside its own, as one for each Workflow; a `fail` among them stops nothing
	readonly lines?: readonly Line[];
}

// A check fails by throwing; its message is the line's detail.
export interface Check<F, O> {
	readonly name: string;
	// the facts it runs on; while one is not found it does not run
	readonly needs: readonly (keyof F)[];
	// the detail of the `skip` line said when a need is not found; null says none
	readonly unmet: string | null;
	readonly run: (found: Partial<F>, o: O) => Promise<Passed<F>> | Passed<F>;
}

interface CheckSpec<F, O, N extends keyof F> {
	readonly name: string;
	readonly needs: readonly N[];
	readonly unmet?: string | null;
	readonly run: (found: Partial<F> & Pick<F, N>, o: O) => Promise<Passed<F>> | Passed<F>;
}

// A maker of checks over the facts F and options O, whose `run` reads each fact it needs as found.
export const checksOver =
	<F, O>() =>
	<N extends keyof F>(spec: CheckSpec<F, O, N>): Check<F, O> => ({
		name: spec.name,
		needs: spec.needs,
		unmet: spec.unmet ?? null,
		// the runner calls it only once every need is found
		run: (found, o) => spec.run(found as Partial<F> & Pick<F, N>, o)
	});

export interface Report<F> {
	readonly lines: readonly Line[];
	readonly found: Partial<F>;
	// the line of the first check that failed; null when none did
	readonly failed: Line | null;
}

export async function runChecks<F, O>(
	checks: readonly Check<F, O>[],
	o: O,
	failFast: boolean,
	given: Partial<F> = {}
): Promise<Report<F>> {
	const lines: Line[] = [];
	const found: Partial<F> = { ...given };
	let failed: Line | null = null;
	for (const c of checks) {
		if (failFast && failed !== null) break;
		if (c.needs.some((need) => found[need] === undefined)) {
			if (c.unmet !== null) {
				lines.push({ name: c.name, status: 'skip', detail: c.unmet, summary: null });
			}
			continue;
		}
		try {
			const passed = await c.run(found, o);
			Object.assign(found, passed.found);
			const { detail, summary } = passed;
			if (detail !== undefined) {
				lines.push({
					name: c.name,
					status: 'ok',
					detail,
					summary: summary === undefined ? detail : summary
				});
			}
			lines.push(...(passed.lines ?? []));
		} catch (fault) {
			// a config fault names its file in every line already
			const detail = why(fault).replace(/^factory\.json: /gm, '');
			const line: Line = { name: c.name, status: 'fail', detail, summary: null };
			lines.push(line);
			failed ??= line;
		}
	}
	return { lines, found, failed };
}
