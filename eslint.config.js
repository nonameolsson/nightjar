import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import ts from 'typescript-eslint';

export default defineConfig(
	{ ignores: ['dist/', 'node_modules/', '.factory/', '.agents/', '.claude/'] },
	js.configs.recommended,
	...ts.configs.strictTypeChecked,
	prettier,
	{
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
		},
		rules: {
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: false }],
			'@typescript-eslint/no-confusing-void-expression': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	},
	{
		// only the GitHub adapters call gh (ticket N1); a spec, or the stand-in machine, may name its stand-in
		files: ['src/**/*.ts'],
		ignores: ['src/github/**', 'src/**/*.spec.ts', 'src/fakes/machine.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector: "Literal[value='gh']",
					message: 'Only the GitHub adapters in src/github/ call gh.'
				}
			]
		}
	},
	{
		files: ['**/*.js'],
		...ts.configs.disableTypeChecked
	}
);
