// The runner by the lines it says over checks of its own, without a machine.
import { describe, expect, it } from 'vitest';
import { checksOver, runChecks } from './check-runner.js';

interface Facts {
	readonly a: string;
	readonly b: string;
}

interface Seen {
	// the checks that ran, in order
	readonly ran: string[];
}

const check = checksOver<Facts, Seen>();
const ran = (): Seen => ({ ran: [] });

const gives = (name: string, fact: keyof Facts) =>
	check({
		name,
		needs: [],
		run: (_found, o) => {
			o.ran.push(name);
			return { found: fact === 'a' ? { a: name } : { b: name }, detail: `found ${name}` };
		}
	});

const fails = (name: string) =>
	check({
		name,
		needs: [],
		run: (_found, o) => {
			o.ran.push(name);
			throw new Error(`${name} is broken`);
		}
	});

const needsA = (unmet: string | null) =>
	check({
		name: 'uses a',
		needs: ['a'],
		unmet,
		run: ({ a }, o) => {
			o.ran.push('uses a');
			return { detail: `read ${a}`, summary: null };
		}
	});

describe('runChecks', () => {
	it('runs each check in order on what the ones before it found', async () => {
		const o = ran();
		const report = await runChecks([gives('first', 'a'), needsA('needs a')], o, true);
		expect(o.ran).toEqual(['first', 'uses a']);
		expect(report.lines).toEqual([
			{ name: 'first', status: 'ok', detail: 'found first', summary: 'found first' },
			{ name: 'uses a', status: 'ok', detail: 'read first', summary: null }
		]);
		expect(report.found).toEqual({ a: 'first' });
		expect(report.failed).toBeNull();
	});

	it('skips a check whose need is not found, saying why, and runs the rest', async () => {
		const o = ran();
		const report = await runChecks(
			[fails('first'), needsA('needs the first'), gives('last', 'b')],
			o,
			false
		);
		expect(o.ran).toEqual(['first', 'last']);
		expect(report.lines.map((l) => [l.name, l.status, l.detail])).toEqual([
			['first', 'fail', 'first is broken'],
			['uses a', 'skip', 'needs the first'],
			['last', 'ok', 'found last']
		]);
		expect(report.failed?.name).toBe('first');
	});

	it('skips without a word a check whose skip says nothing', async () => {
		const report = await runChecks([needsA(null)], ran(), false);
		expect(report.lines).toEqual([]);
	});

	it('fails fast: stops at the first check that fails, saying nothing after it', async () => {
		const o = ran();
		const report = await runChecks(
			[gives('first', 'b'), fails('second'), fails('third'), needsA('needs a')],
			o,
			true
		);
		expect(o.ran).toEqual(['first', 'second']);
		expect(report.lines.map((l) => [l.name, l.status])).toEqual([
			['first', 'ok'],
			['second', 'fail']
		]);
		expect(report.failed?.detail).toBe('second is broken');
	});

	it('names the first failure, when every check runs', async () => {
		const report = await runChecks([fails('second'), fails('third')], ran(), false);
		expect(report.lines.map((l) => l.status)).toEqual(['fail', 'fail']);
		expect(report.failed?.name).toBe('second');
	});

	it("says a check's own lines, whose failures stop nothing", async () => {
		const o = ran();
		const own = check({
			name: 'Workflows',
			needs: [],
			run: () => ({
				lines: [{ name: 'Workflow w', status: 'fail', detail: 'broken', summary: null, only: 'w' }]
			})
		});
		const report = await runChecks([own, gives('after', 'a')], o, true);
		expect(report.lines.map((l) => [l.name, l.status])).toEqual([
			['Workflow w', 'fail'],
			['after', 'ok']
		]);
		expect(report.failed).toBeNull();
	});

	it('drops the file name from a factory.json fault, which says it on every line', async () => {
		const config = check({
			name: 'factory.json',
			needs: [],
			run: () => {
				throw new Error('factory.json: check: missing\nfactory.json: allowedCommands: missing');
			}
		});
		const report = await runChecks([config], ran(), false);
		expect(report.lines[0]?.detail).toBe('check: missing\nallowedCommands: missing');
	});
});
