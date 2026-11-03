// The Spend module's in-memory adapter, which the build loop's specs run over in place of runs.jsonl.
import { spendOver, type Entry, type Spend } from '../spend.js';

export function memorySpend(): Spend {
	const lines: Entry[] = [];
	return spendOver({
		append: (entry) => {
			lines.push(entry);
		},
		read: () => [...lines]
	});
}
