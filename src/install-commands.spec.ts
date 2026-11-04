import { describe, expect, it } from 'vitest';
import { installs } from './install-commands.js';

describe('an allowedCommands pattern that installs packages', () => {
	it.each([
		'npm install',
		'npm install *',
		'npm install:*',
		'npm ci',
		'pnpm install --frozen-lockfile',
		'pip install -r requirements.txt',
		'uv sync',
		'go mod download',
		'yarn',
		'yarn install',
		'yarn install --immutable',
		'yarn --frozen-lockfile'
	])('%s installs', (pattern) => {
		expect(installs(pattern)).toBe(true);
	});

	it.each([
		'npm test',
		'npm run check',
		'npm',
		'go test ./...',
		'yarn test',
		'yarn run build',
		'yarn --version',
		'yarn -v',
		'yarn --help',
		'yarn -h',
		'cargo build'
	])('%s does not', (pattern) => {
		expect(installs(pattern)).toBe(false);
	});
});
