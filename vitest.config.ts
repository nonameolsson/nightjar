import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// the leak check shells out to git and npm
		testTimeout: 60_000,
		include: ['src/**/*.spec.ts', 'plugin/**/*.spec.ts', 'scripts/**/*.spec.ts']
	}
});
