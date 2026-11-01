// Questions put to a person on a terminal, or to a script that pipes its answers in, one per line.
import { createInterface } from 'node:readline';

// The answer, or null once the input has ended.
export type Ask = (question: string) => Promise<string | null>;

export interface Asker {
	readonly ask: Ask;
	readonly close: () => void;
}

export function askOnStdin(): Asker {
	const tty = process.stdin.isTTY;
	// on a terminal readline echoes what is typed; a pipe has no echo, so the answer is written out
	const lines = createInterface({
		input: process.stdin,
		...(tty ? { output: process.stdout } : {}),
		terminal: tty
	});
	const iterator = lines[Symbol.asyncIterator]();
	return {
		ask: async (question) => {
			process.stdout.write(question);
			const next = await iterator.next();
			if (next.done) {
				process.stdout.write('\n');
				return null;
			}
			if (!tty) process.stdout.write(`${next.value}\n`);
			return next.value;
		},
		close: () => lines.close()
	};
}
