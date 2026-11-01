import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// raised from 5s: specs shell out to git and npm, which take seconds on a busy machine
		testTimeout: 60_000,
		include: ['src/**/*.spec.ts', 'plugin/**/*.spec.ts', 'scripts/**/*.spec.ts']
	}
});
