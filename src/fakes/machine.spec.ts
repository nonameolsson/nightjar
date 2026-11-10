import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STAND_INS, machine, type Tool } from './machine.js';

// The PATH of a machine holds git and the stand-ins, so any other command finds nothing and prints nothing.
const EXTERNAL = [
	'sed',
	'grep',
	'awk',
	'cut',
	'tr',
	'cat',
	'head',
	'tail',
	'sort',
	'date',
	'ls',
	'rm'
];

// The commands of a script: the first word of each line and of each `$(...)`, `|` and `;` part.
function commandWords(script: string): string[] {
	return script
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('#'))
		.flatMap((line) => line.split(/\$\(|\||;|&&|\|\|/))
		.flatMap((part) => part.trim().split(/\s+/).slice(0, 1));
}

describe('the stand-in tools', () => {
	it.each(Object.keys(STAND_INS) as Tool[])('%s uses shell builtins only', (tool) => {
		const used = commandWords(STAND_INS[tool]).filter((w) => EXTERNAL.includes(w));
		expect(used).toEqual([]);
	});

	it("answers a Feedback round's session on the first feedback id its prompt names", () => {
		const m = machine();
		try {
			const args = ['-p', 'Answer `comment:12` and `review:4`.', '--session-id', 's'];
			const got = spawnSync(
				join(m.base, 'bin', 'claude'),
				[...args, '--json-schema', '{"feedbackId":{}}'],
				{ cwd: m.root, env: m.env, encoding: 'utf8' }
			);
			const result = JSON.parse(got.stdout.trim().split('\n').at(-1) ?? '{}') as {
				structured_output?: unknown;
			};
			expect(result.structured_output).toEqual({
				outcome: 'answered',
				summary: 'Answered it.',
				items: [{ feedbackId: 'comment:12', answered: true, note: 'Changed it.' }],
				blocker: ''
			});
			expect(existsSync(join(m.root, 'answered.txt'))).toBe(true);
		} finally {
			m.remove();
		}
	});

	it('catches a stand-in that calls an external command', () => {
		expect(commandWords('x=$(echo a | sed s/a/b/)').filter((w) => EXTERNAL.includes(w))).toEqual([
			'sed'
		]);
	});
});
