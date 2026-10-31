// Azure DevOps sign-in: the Azure CLI's token first, else a personal access token from the environment.
import { z } from 'zod';
import { firstLine, run, type Env, type Run } from '../git.js';
import { AzureDevOpsFailure } from './api.js';

// The resource id Azure DevOps tokens are issued for, the same in every tenant.
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

// The variable the Azure CLI's own devops extension reads, so one token serves both.
export const PAT_VARIABLE = 'AZURE_DEVOPS_EXT_PAT';

export type AzRunner = (args: readonly string[]) => Promise<Run>;

export const azRunner =
	(cwd: string, env: Env): AzRunner =>
	(args) =>
		run('az', args, cwd, env);

export interface AzureDevOpsSignIn {
	// the Authorization header every call carries
	authorization(): Promise<string>;
	// what it signed in with, for the preflight line and the refusals
	via(): Promise<string>;
	// asks for a fresh token after Azure DevOps refused one; a personal access token has none fresher
	refresh(): Promise<void>;
}

const TokenSchema = z.looseObject({ accessToken: z.string().min(1) });

interface Held {
	readonly authorization: string;
	readonly via: string;
	readonly fromAz: boolean;
}

export function azureDevOpsSignIn(az: AzRunner, env: Env): AzureDevOpsSignIn {
	let held: Promise<Held> | null = null;

	// The Azure CLI's token, or why there is none.
	async function fromAz(): Promise<string | { why: string }> {
		const got = await az([
			'account',
			'get-access-token',
			'--resource',
			AZURE_DEVOPS_RESOURCE,
			'--output',
			'json'
		]);
		if (got.missing) return { why: 'az is not on the PATH' };
		if (!got.ok) return { why: `az: ${firstLine(got.err) || firstLine(got.out)}` };
		let value: unknown = null;
		try {
			value = JSON.parse(got.out);
		} catch {
			// no JSON reads as no token
		}
		const parsed = TokenSchema.safeParse(value);
		return parsed.success ? parsed.data.accessToken : { why: 'az printed no token' };
	}

	async function signIn(): Promise<Held> {
		const token = await fromAz();
		if (typeof token === 'string') {
			return { authorization: `Bearer ${token}`, via: 'the Azure CLI', fromAz: true };
		}
		const pat = env[PAT_VARIABLE]?.trim() ?? '';
		if (pat !== '') {
			return {
				authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
				via: `the personal access token in ${PAT_VARIABLE}`,
				fromAz: false
			};
		}
		throw new AzureDevOpsFailure(
			`Nightjar cannot sign in to Azure DevOps: run \`az login\`, or set ${PAT_VARIABLE} to a personal access token (${token.why}).`
		);
	}

	const current = () => {
		held ??= signIn().catch((fault: unknown) => {
			held = null;
			throw fault;
		});
		return held;
	};

	return {
		authorization: async () => (await current()).authorization,
		via: async () => (await current()).via,
		async refresh() {
			if (held !== null && (await held).fromAz) held = null;
		}
	};
}
