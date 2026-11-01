import { describe, expect, it } from 'vitest';
import type { Run } from '../git.js';
import { AzureDevOpsFailure } from './api.js';
import {
	AZURE_DEVOPS_RESOURCE,
	PAT_VARIABLE,
	azureDevOpsSignIn,
	type AzRunner
} from './sign-in.js';

const answered = (out: string): Run => ({ ok: true, out, err: '', missing: false });
const NOT_ON_PATH: Run = { ok: false, out: '', err: '', missing: true };
const SIGNED_OUT: Run = {
	ok: false,
	out: '',
	err: "ERROR: Please run 'az login' to setup account.\n",
	missing: false
};

// An az that answers each call with the next of `runs`, and keeps what it was asked.
function fakeAz(...runs: Run[]) {
	const asked: (readonly string[])[] = [];
	const az: AzRunner = (args) => {
		asked.push(args);
		return Promise.resolve(runs.shift() ?? SIGNED_OUT);
	};
	return { az, asked };
}

const token = (accessToken: string) =>
	answered(JSON.stringify({ accessToken, tokenType: 'Bearer', expiresOn: '2026-10-31 18:00:00' }));

const basic = (pat: string) => `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

describe('signing in to Azure DevOps', () => {
	it("signs in with the Azure CLI's token first, even when a personal access token is set", async () => {
		const { az, asked } = fakeAz(token('from-az'));
		const signIn = azureDevOpsSignIn(az, { [PAT_VARIABLE]: 'a-pat' });
		expect(await signIn.authorization()).toBe('Bearer from-az');
		expect(await signIn.via()).toBe('the Azure CLI');
		expect(asked).toEqual([
			['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--output', 'json']
		]);
	});

	it('asks az once, and again only when told to refresh', async () => {
		const { az, asked } = fakeAz(token('first'), token('second'));
		const signIn = azureDevOpsSignIn(az, {});
		await signIn.authorization();
		await signIn.authorization();
		expect(asked).toHaveLength(1);
		await signIn.refresh();
		expect(await signIn.authorization()).toBe('Bearer second');
		expect(asked).toHaveLength(2);
	});

	it.each([
		['az is not on the PATH', NOT_ON_PATH],
		['az is signed out', SIGNED_OUT],
		['az prints no token', answered('{}')]
	])('signs in with the personal access token when %s', async (_why, azRun) => {
		const { az } = fakeAz(azRun);
		const signIn = azureDevOpsSignIn(az, { [PAT_VARIABLE]: 'a-pat' });
		expect(await signIn.authorization()).toBe(basic('a-pat'));
		expect(await signIn.via()).toBe(`the personal access token in ${PAT_VARIABLE}`);
	});

	it('says how to sign in when there is neither, and why az gave nothing', async () => {
		const { az } = fakeAz(SIGNED_OUT);
		const signIn = azureDevOpsSignIn(az, { [PAT_VARIABLE]: '  ' });
		const fault = await signIn.authorization().catch((e: unknown) => e);
		expect(fault).toBeInstanceOf(AzureDevOpsFailure);
		const message = (fault as Error).message;
		expect(message).toContain('az login');
		expect(message).toContain(PAT_VARIABLE);
		expect(message).toContain("Please run 'az login' to setup account.");
	});
});
