import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.spec.ts', 'plugin/**/*.spec.ts', 'scripts/**/*.spec.ts']
	}
});
