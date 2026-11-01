#!/usr/bin/env node
import { runNightjar } from './main.js';
import { why } from './say.js';

try {
	process.exit(await runNightjar(process.argv.slice(2)));
} catch (fault) {
	console.error(`nightjar: ${why(fault)}`);
	process.exit(1);
}
