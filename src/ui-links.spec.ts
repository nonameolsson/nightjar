import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';
import { linksFor, NO_LINKS } from './ui-links.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const inRepo = (config: unknown, origin: string | null = null) => {
	const root = mkdtempSync(join(tmpdir(), 'nightjar-links-'));
	try {
		writeFileSync(join(root, 'factory.json'), JSON.stringify(config));
		return linksFor(root, origin);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

describe('page links', () => {
	it('points Tickets and pull requests at the GitHub repo factory.json names', () => {
		const links = inRepo({
			tracker: { type: 'github', repo: 'o/app' },
			codeHost: { type: 'github', repo: 'o/app' },
			check: 'npm test',
			allowedCommands: ['npm test']
		});
		expect(links.tracker).toBe('GitHub');
		expect(links.issue('12')).toBe('https://github.com/o/app/issues/12');
		expect(links.issues).toBe('https://github.com/o/app/issues');
		expect(links.pulls).toBe('https://github.com/o/app/pulls');
	});

	it('reads the repo from the origin remote when factory.json leaves it out', () => {
		const links = inRepo(
			{
				tracker: { type: 'github' },
				codeHost: { type: 'github' },
				check: 'npm test',
				allowedCommands: ['npm test']
			},
			'git@github.com:o/app.git'
		);
		expect(links.issue('7')).toBe('https://github.com/o/app/issues/7');
	});

	it('points at Azure DevOps work items and pull requests', () => {
		const links = inRepo({
			tracker: {
				type: 'azure-devops',
				organization: 'contoso',
				project: 'My Proj',
				featureType: 'Feature'
			},
			codeHost: { type: 'azure-devops', organization: 'contoso', project: 'My Proj', repo: 'web' },
			check: 'npm test',
			allowedCommands: ['npm test']
		});
		expect(links.tracker).toBe('Azure DevOps');
		expect(links.issue('42')).toBe('https://dev.azure.com/contoso/My%20Proj/_workitems/edit/42');
		expect(links.pulls).toBe('https://dev.azure.com/contoso/My%20Proj/_git/web/pullrequests');
	});

	it('links no id that is not a number, and nothing without a readable factory.json', () => {
		const links = inRepo({
			tracker: { type: 'github', repo: 'o/app' },
			codeHost: { type: 'github', repo: 'o/app' },
			check: 'npm test',
			allowedCommands: ['npm test']
		});
		expect(links.issue('../x')).toBeNull();
		expect(linksFor('/nonexistent-nightjar-root', null)).toEqual(NO_LINKS);
		expect(NO_LINKS.signals).toEqual(DEFAULT_SIGNAL_NAMES);
	});

	it('carries the Signal names the repo configured', () => {
		const links = inRepo({
			tracker: { type: 'github', repo: 'o/app' },
			codeHost: { type: 'github', repo: 'o/app' },
			check: 'npm test',
			allowedCommands: ['npm test'],
			signals: { needsInfo: 'question' }
		});
		expect(links.signals.needsInfo).toBe('question');
		expect(links.signals.ready).toBe('ready-for-agent');
	});
});
