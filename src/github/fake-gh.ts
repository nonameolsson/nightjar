// A stand-in for `gh api`, for the GitHub adapters' specs: it answers each call from the routes
// it is given and records every call, so no spec reaches the network.
import type { Run } from '../git.js';

export interface GhCall {
	readonly method: string;
	// the path without its query
	readonly path: string;
	readonly query: URLSearchParams;
	// the -f and -F fields, by name; a name ending in [] collects every value
	readonly fields: Readonly<Record<string, string | string[]>>;
	readonly args: readonly string[];
}

export type Route = (call: GhCall) => Run | undefined;

export const ok = (value: unknown): Run => ({
	ok: true,
	out: JSON.stringify(value),
	err: '',
	missing: false
});

export const failed = (err: string): Run => ({ ok: false, out: '', err, missing: false });

export function readCall(args: readonly string[]): GhCall {
	let method = 'GET';
	let target = '';
	const fields: Record<string, string | string[]> = {};
	for (let i = 1; i < args.length; i += 1) {
		const a = args[i] ?? '';
		if (a === '-X') method = args[(i += 1)] ?? '';
		else if (a === '-f' || a === '-F') {
			const field = args[(i += 1)] ?? '';
			const at = field.indexOf('=');
			const name = field.slice(0, at);
			const value = field.slice(at + 1);
			const had = fields[name];
			fields[name] = name.endsWith('[]') ? [...(Array.isArray(had) ? had : []), value] : value;
		} else if (!a.startsWith('-')) target = a;
	}
	const [path = '', query = ''] = target.split('?');
	return { method, path, query: new URLSearchParams(query), fields, args };
}

// Each call goes to the first route that answers it; a call no route answers is a 404.
export function fakeGh(...routes: Route[]) {
	const calls: GhCall[] = [];
	const gh = (args: readonly string[]): Promise<Run> => {
		const call = readCall(args);
		calls.push(call);
		for (const route of routes) {
			const answer = route(call);
			if (answer !== undefined) return Promise.resolve(answer);
		}
		return Promise.resolve(failed('gh: Not Found (HTTP 404)'));
	};
	return { gh, calls };
}

// A route answering one method and path.
export const on =
	(method: string, path: string, answer: Run | ((call: GhCall) => Run)): Route =>
	(call) =>
		call.method === method && call.path === path
			? typeof answer === 'function'
				? answer(call)
				: answer
			: undefined;
