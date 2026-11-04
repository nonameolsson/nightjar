#!/usr/bin/env node
import { runNightjar } from './main.js';
import { why } from './say.js';
import { thisOs } from './sandbox.js';

try {
	process.exit(await runNightjar(process.argv.slice(2), { os: thisOs() }));
} catch (fault) {
	console.error(`nightjar: ${why(fault)}`);
	process.exit(1);
}
