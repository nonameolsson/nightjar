import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	AzureDevOpsApi,
	AzureDevOpsFailure,
	type AzureDevOpsCall,
	type AzureDevOpsReply
} from './api.js';
import type { AzureDevOpsSignIn } from './sign-in.js';

// A sign-in whose token changes each time it is refreshed.
function fakeSignIn() {
	let token = 1;
	let refreshes = 0;
	const signIn: AzureDevOpsSignIn = {
		authorization: () => Promise.resolve(`Bearer t${String(token)}`),
		via: () => Promise.resolve('the Azure CLI'),
		refresh: () => {
			refreshes += 1;
			token += 1;
			return Promise.resolve();
		}
	};
	return { signIn, refreshes: () => refreshes };
}

// Azure DevOps as a script: each call takes the next reply, or throws it.
function scripted(...replies: (AzureDevOpsReply | Error)[]) {
	const sent: { url: string; call: AzureDevOpsCall }[] = [];
	const request = (url: string, call: AzureDevOpsCall) => {
		sent.push({ url, call });
		const next = replies.shift();
		if (next === undefined) throw new Error('the script has no more replies');
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	};
	return { request, sent };
}

const json = (status: number, body: unknown): AzureDevOpsReply => ({
	status,
	text: JSON.stringify(body)
});

const failureOf = async (promise: Promise<unknown>) => {
	const fault = await promise.catch((e: unknown) => e);
	if (!(fault instanceof AzureDevOpsFailure))
		throw new Error(`no AzureDevOpsFailure: ${String(fault)}`);
	return fault;
};

describe('the Azure DevOps API', () => {
	it("sends each call signed in, as JSON, to the organization's own host", async () => {
		const { request, sent } = scripted(json(200, { id: 7 }));
		const api = new AzureDevOpsApi('contoso', fakeSignIn().signIn, request);
		const got = await api.call('add a comment', {
			method: 'POST',
			url: api.at('Fabrikam%20Fiber/_apis/wit/workItems/7/comments?api-version=7.1-preview.4'),
			body: { text: 'Hi' }
		});
		expect(got).toEqual({ id: 7 });
		expect(sent).toEqual([
			{
				url: 'https://dev.azure.com/contoso/Fabrikam%20Fiber/_apis/wit/workItems/7/comments?api-version=7.1-preview.4',
				call: {
					method: 'POST',
					headers: {
						Authorization: 'Bearer t1',
						Accept: 'application/json',
						'Content-Type': 'application/json'
					},
					body: '{"text":"Hi"}'
				}
			}
		]);
		expect(api.identities('_apis/identities?api-version=7.1')).toBe(
			'https://vssps.dev.azure.com/contoso/_apis/identities?api-version=7.1'
		);
	});

	it('sends a body of the content type a call names', async () => {
		const { request, sent } = scripted(json(200, {}));
		const api = new AzureDevOpsApi('contoso', fakeSignIn().signIn, request);
		await api.call('tag work item 7', {
			method: 'PATCH',
			url: api.at('Fabrikam/_apis/wit/workitems/7?api-version=7.1'),
			body: [{ op: 'add', path: '/fields/System.Tags', value: 'a' }],
			contentType: 'application/json-patch+json'
		});
		expect(sent[0]?.call.headers['Content-Type']).toBe('application/json-patch+json');
	});

	it('refreshes the sign-in once after a 401 and sends the call again', async () => {
		const { signIn, refreshes } = fakeSignIn();
		const { request, sent } = scripted({ status: 401, text: '' }, json(200, { count: 0 }));
		const api = new AzureDevOpsApi('contoso', signIn, request);
		expect(await api.call('read', { method: 'GET', url: api.at('_apis/x') })).toEqual({ count: 0 });
		expect(refreshes()).toBe(1);
		expect(sent.map((s) => s.call.headers.Authorization)).toEqual(['Bearer t1', 'Bearer t2']);
	});

	it.each([
		['a second 401', { status: 401, text: '' }],
		['a 403', { status: 403, text: '' }],
		[
			'the sign-in page Azure DevOps answers a token it does not take with',
			{ status: 203, text: '<html>Sign in</html>' }
		]
	])('names the sign-in it refused after %s', async (_what, refusal) => {
		const { request } = scripted({ status: 401, text: '' }, refusal);
		const api = new AzureDevOpsApi('contoso', fakeSignIn().signIn, request);
		const fault = await failureOf(
			api.call('read work item 7', { method: 'GET', url: api.at('_apis/x') })
		);
		expect(fault.message).toMatch(/Azure DevOps refused the Azure CLI/);
		expect(fault.message).toContain('read work item 7');
	});

	it("names the call, the status and Azure DevOps's own message when it refuses a call", async () => {
		const { request } = scripted(
			json(404, {
				message: 'TF401232: Work item 9 does not exist.',
				typeKey: 'WorkItemDoesNotExistException'
			})
		);
		const api = new AzureDevOpsApi('contoso', fakeSignIn().signIn, request);
		const fault = await failureOf(
			api.call('read work item 9', { method: 'GET', url: api.at('_apis/x') })
		);
		expect(fault.status).toBe(404);
		expect(fault.message).toBe(
			'Azure DevOps could not read work item 9: HTTP 404: TF401232: Work item 9 does not exist.'
		);
	});

	it('is a failure when Azure DevOps cannot be reached or answers no JSON', async () => {
		const unreachable = scripted(new TypeError('fetch failed'));
		const api = new AzureDevOpsApi('contoso', fakeSignIn().signIn, unreachable.request);
		expect(
			(await failureOf(api.call('read', { method: 'GET', url: api.at('_apis/x') }))).message
		).toBe('Azure DevOps could not read: fetch failed');
		const garbled = scripted({ status: 200, text: '<html>' });
		const other = new AzureDevOpsApi('contoso', fakeSignIn().signIn, garbled.request);
		expect(
			(await failureOf(other.call('read', { method: 'GET', url: other.at('_apis/x') }))).message
		).toBe('Azure DevOps answered no JSON when asked to read.');
	});

	it('answers an empty reply as null, and refuses an answer of a shape it does not know', async () => {
		const { request } = scripted({ status: 204, text: '' }, json(200, { value: 'no list' }));
		const api = new AzureDevOpsApi('contoso', fakeSignIn().signIn, request);
		expect(await api.call('delete', { method: 'DELETE', url: api.at('_apis/x') })).toBeNull();
		const schema = z.looseObject({ value: z.array(z.unknown()) });
		const fault = await failureOf(
			api.parse('list work items', { method: 'GET', url: api.at('_apis/x') }, schema)
		);
		expect(fault.message).toBe('Azure DevOps answered list work items in a shape not known.');
	});
});
