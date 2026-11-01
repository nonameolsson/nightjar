// Writes schema/factory.schema.json from the definition factory.json is validated with.
import { mkdirSync, writeFileSync } from 'node:fs';
import { configJsonSchema } from '../src/config.js';

const folder = new URL('../schema/', import.meta.url);
mkdirSync(folder, { recursive: true });
writeFileSync(
	new URL('factory.schema.json', folder),
	`${JSON.stringify(configJsonSchema(), null, '\t')}\n`
);
