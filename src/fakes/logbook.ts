// The Logbook's in-memory adapter, which the build loop's specs assert over in place of .factory/logbook/.
import type { Logbook, LogbookEntry } from '../logbook.js';
import type { ItemId } from '../tracker.js';

export interface MemoryLogbook extends Logbook {
	// every entry written, of every Feature, oldest first
	readonly all: () => readonly LogbookEntry[];
}

export function memoryLogbook(): MemoryLogbook {
	const lines: LogbookEntry[] = [];
	return {
		write: (entry) => {
			// a copy, as the file keeps what was written and not the object
			lines.push(JSON.parse(JSON.stringify(entry)) as LogbookEntry);
		},
		read: (feature: ItemId) => {
			const own = lines.filter((e) => e.feature === feature);
			return own.length === 0 ? null : own;
		},
		all: () => [...lines]
	};
}
