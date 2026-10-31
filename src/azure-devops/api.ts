// The one way Nightjar reaches Azure DevOps: its REST API over HTTPS, signed in. Every Azure DevOps
// Adapter calls through here; the request seam lets a spec answer from a fake Azure DevOps instead.
import type { z } from 'zod';
import type { AzureDevOpsSignIn } from './sign-in.js';
import { why } from '../say.js';

// An Azure DevOps call Nightjar cannot do without; its message names the call and the reason.
export class AzureDevOpsFailure extends Error {
	constructor(
		message: string,
		// the HTTP status Azure DevOps answered, when it answered one
		readonly status?: number
	) {
		super(message);
	}
}

export interface AzureDevOpsCall {
	readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
}

export interface AzureDevOpsReply {
	readonly status: number;
	readonly text: string;
}

// One HTTP exchange; throws only when no answer came.
export type AzureDevOpsRequest = (url: string, call: AzureDevOpsCall) => Promise<AzureDevOpsReply>;

const WAIT_MS = 60_000;

export const fetchRequest: AzureDevOpsRequest = async (url, call) => {
	const reply = await fetch(url, { ...call, signal: AbortSignal.timeout(WAIT_MS) });
	return { status: reply.status, text: await reply.text() };
};

export interface Sending {
	readonly method: AzureDevOpsCall['method'];
	// a whole address, from `at` or `identities`
	readonly url: string;
	// sent as JSON
	readonly body?: unknown;
	// JSON unless named, such as application/json-patch+json for a work item's fields
	readonly contentType?: string;
}

// what Azure DevOps answers a call it refuses with, as far as a message goes
const said = (text: string): string => {
	try {
		const value = JSON.parse(text) as { message?: unknown } | null;
		if (typeof value?.message === 'string') return value.message;
	} catch {
		// not JSON: its first line says as much as anything
	}
	return text.trim().split('\n')[0] ?? '';
};

export class AzureDevOpsApi {
	constructor(
		readonly organization: string,
		readonly signIn: AzureDevOpsSignIn,
		private readonly request: AzureDevOpsRequest = fetchRequest
	) {}

	// An address on the organization's own host: `path` comes after dev.azure.com/<organization>/.
	at(path: string): string {
		return `https://dev.azure.com/${encodeURIComponent(this.organization)}/${path}`;
	}

	// An address on the organization's identity host, which answers who people are and their groups.
	identities(path: string): string {
		return `https://vssps.dev.azure.com/${encodeURIComponent(this.organization)}/${path}`;
	}

	// The JSON Azure DevOps answers, or null for an empty answer.
	async call(what: string, sending: Sending): Promise<unknown> {
		let reply = await this.send(what, sending);
		if (reply.status === 401) {
			await this.signIn.refresh();
			reply = await this.send(what, sending);
		}
		// 203 is the sign-in page Azure DevOps answers a token it does not take with
		if (reply.status === 401 || reply.status === 403 || reply.status === 203) {
			throw new AzureDevOpsFailure(
				`Azure DevOps refused ${await this.signIn.via()} when asked to ${what}: HTTP ${String(reply.status)}`,
				reply.status
			);
		}
		if (reply.status >= 400) {
			const reason = said(reply.text);
			throw new AzureDevOpsFailure(
				`Azure DevOps could not ${what}: HTTP ${String(reply.status)}${reason ? `: ${reason}` : ''}`,
				reply.status
			);
		}
		if (reply.text.trim() === '') return null;
		try {
			return JSON.parse(reply.text) as unknown;
		} catch {
			throw new AzureDevOpsFailure(`Azure DevOps answered no JSON when asked to ${what}.`);
		}
	}

	async parse<T>(what: string, sending: Sending, schema: z.ZodType<T>): Promise<T> {
		const parsed = schema.safeParse(await this.call(what, sending));
		if (!parsed.success) {
			throw new AzureDevOpsFailure(`Azure DevOps answered ${what} in a shape not known.`);
		}
		return parsed.data;
	}

	private async send(what: string, sending: Sending): Promise<AzureDevOpsReply> {
		const headers: Record<string, string> = {
			Authorization: await this.signIn.authorization(),
			Accept: 'application/json'
		};
		if (sending.body !== undefined) {
			headers['Content-Type'] = sending.contentType ?? 'application/json';
		}
		try {
			return await this.request(sending.url, {
				method: sending.method,
				headers,
				...(sending.body === undefined ? {} : { body: JSON.stringify(sending.body) })
			});
		} catch (fault) {
			const reason = why(fault);
			throw new AzureDevOpsFailure(`Azure DevOps could not ${what}: ${reason}`);
		}
	}
}
