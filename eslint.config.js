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
		files: ['**/*.js'],
		...ts.configs.disableTypeChecked
	}
);
