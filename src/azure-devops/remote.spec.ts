import { describe, expect, it } from 'vitest';
import { azureRepoFromRemote } from './remote.js';

describe('azureRepoFromRemote', () => {
	const named = { organization: 'contoso', project: 'Fabrikam', repo: 'fabrikam-app' };

	it.each([
		'https://dev.azure.com/contoso/Fabrikam/_git/fabrikam-app',
		'https://contoso@dev.azure.com/contoso/Fabrikam/_git/fabrikam-app',
		'git@ssh.dev.azure.com:v3/contoso/Fabrikam/fabrikam-app',
		'contoso@vs-ssh.visualstudio.com:v3/contoso/Fabrikam/fabrikam-app',
		'https://contoso.visualstudio.com/Fabrikam/_git/fabrikam-app',
		'https://dev.azure.com/contoso/Fabrikam/_git/fabrikam-app/\n'
	])('reads %s', (url) => {
		expect(azureRepoFromRemote(url)).toEqual(named);
	});

	it('reads a name as a person does, a space spelled %20', () => {
		const url = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/fabrikam%20app';
		expect(azureRepoFromRemote(url)).toEqual({
			organization: 'contoso',
			project: 'Fabrikam Web',
			repo: 'fabrikam app'
		});
	});

	it.each([
		'git@github.com:o/app.git',
		'https://example.com/contoso/Fabrikam/_git/fabrikam-app',
		'https://dev.azure.com/contoso/Fabrikam'
	])('names nothing for %s', (url) => {
		expect(azureRepoFromRemote(url)).toBeNull();
	});
});
