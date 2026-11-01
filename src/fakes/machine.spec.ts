import { describe, expect, it } from 'vitest';
import { STAND_INS, type Tool } from './machine.js';

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

	it('catches a stand-in that calls an external command', () => {
		expect(commandWords('x=$(echo a | sed s/a/b/)').filter((w) => EXTERNAL.includes(w))).toEqual([
			'sed'
		]);
	});
});
