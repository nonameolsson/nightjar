#!/usr/bin/env node
import { runNightjar } from './main.js';

try {
	process.exit(await runNightjar(process.argv.slice(2)));
} catch (fault) {
	console.error(`nightjar: ${fault instanceof Error ? fault.message : String(fault)}`);
	process.exit(1);
}
