// `nightjar doctor FEATURE`: each open Ticket of a Feature against the Ticket contract, with no machine check and nothing written to the Tracker.
import { makeAdapters } from './adapters.js';
import type { AzureDevOpsRequest } from './azure-devops/index.js';
import { ConfigError, loadConfig } from './config.js';
import type { GhRunner } from './github/api.js';
import { run, type Env } from './git.js';
import { say, why } from './say.js';
import { ticketFaults } from './ticket-contract.js';
import type { ItemId, Tracker } from './tracker.js';

// One line per open Ticket: its reference, then `ok` or each fault. Gives the number of Tickets that fail.
export async function checkFeatureTickets(
	tracker: Tracker,
	feature: ItemId,
	tell: (line: string) => void
): Promise<number> {
	let failing = 0;
	for (const ticket of await tracker.tickets(feature)) {
		if (!ticket.open) continue;
		const faults = ticketFaults(ticket.body);
		if (faults.length > 0) failing += 1;
		tell(`${tracker.reference(ticket.id).text}: ${faults.length === 0 ? 'ok' : faults.join(' ')}`);
	}
	return failing;
}

export interface FeatureDoctorOptions {
	readonly feature: ItemId;
	readonly env: Env;
	readonly cwd: string;
	readonly request?: AzureDevOpsRequest;
	readonly gh?: GhRunner;
}

const refuse = (text: string) => {
	console.error(`nightjar: ${text}`);
	return 2;
};

// 0 when every open Ticket passes, 1 when any fails, 2 when the Feature could not be read.
export async function runFeatureDoctor(o: FeatureDoctorOptions): Promise<number> {
	const top = await run('git', ['rev-parse', '--show-toplevel'], o.cwd, o.env);
	if (!top.ok) return refuse('not inside a git checkout');
	const root = top.out.trim();
	let tracker: Tracker;
	try {
		const config = loadConfig(root);
		tracker = (
			await makeAdapters(config, root, o.env, {
				...(o.request === undefined ? {} : { request: o.request }),
				...(o.gh === undefined ? {} : { gh: o.gh })
			})
		).tracker;
	} catch (fault) {
		if (fault instanceof ConfigError) return refuse(fault.message);
		return refuse(why(fault));
	}
	let failing: number;
	try {
		failing = await checkFeatureTickets(tracker, o.feature, say);
	} catch (fault) {
		return refuse(`cannot read the Tickets of ${o.feature}: ${why(fault)}`);
	}
	return failing === 0 ? 0 : 1;
}
