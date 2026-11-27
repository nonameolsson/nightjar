import { describe, expect, it } from 'vitest';
import { AzureDevOpsApi } from './api.js';
import { FakeAzureDevOps, type FakeProcess } from './fake-azure-devops.js';
import { projectProcess } from './process.js';

const read = (process: FakeProcess) => {
	const ado = new FakeAzureDevOps('contoso', 'Fabrikam', 'ann@contoso.com');
	ado.process = process;
	return projectProcess(new AzureDevOpsApi('contoso', ado.signIn(), ado.request), 'Fabrikam');
};

describe('projectProcess', () => {
	it('names a system process, with its types', async () => {
		expect(await read({ system: 'Basic' })).toEqual({
			name: 'Basic',
			types: { featureType: 'Epic', ticketType: 'Issue' }
		});
	});

	it('takes an inherited process by its own name, with the types of the one it inherits from', async () => {
		expect(await read({ inherited: 'Contoso CMMI', from: 'CMMI' })).toEqual({
			name: 'Contoso CMMI',
			types: { featureType: 'Feature', ticketType: 'Requirement' }
		});
	});

	it('gives no types for a process uploaded as XML, even one named as a system process', async () => {
		expect(await read({ custom: 'Agile' })).toEqual({ name: 'Agile', types: null });
	});
});
