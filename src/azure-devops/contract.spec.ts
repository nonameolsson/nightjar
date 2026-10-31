// The Azure Boards Tracker against the contract suite, over a fake Azure DevOps: no spec here reaches the network.
import { describe, it } from 'vitest';
import {
	DEFAULT_SIGNAL_NAMES,
	trackerContract,
	type SignalNames,
	type TrackerWorld
} from '../index.js';
import { AzureDevOpsApi } from './api.js';
import { FakeAzureDevOps } from './fake-azure-devops.js';
import { AzureBoardsTracker } from './tracker.js';

// Signal names and a trusted list as a repo's factory.json may set them.
const CONFIGURED: SignalNames = {
	go: 'Build this',
	ready: 'agent-may-build',
	working: 'agent-on-it',
	needsInfo: 'agent-asks',
	human: 'for-a-person'
};

// A project name with a space, as many have, so every address must encode it.
const PROJECT = 'Fabrikam Fiber';

// With a trusted list everyone is a Contributor, so only the list can make the world's trust.
const azureBoardsTracker =
	(names: SignalNames, trust: 'Contributors' | 'trusted list') => (world: TrackerWorld) => {
		const ado = new FakeAzureDevOps('contoso', PROJECT, world.person);
		const people = new Set([
			world.person,
			...world.trusted,
			...world.items.flatMap((i) => [
				...(i.assignees ?? []),
				...(i.comments ?? []).map((c) => c.author)
			])
		]);
		for (const person of people) {
			ado.join(person, { contributor: trust === 'trusted list' || world.trusted.includes(person) });
		}
		const ids = new Map<string, number>();
		const id = (key: string) => {
			const found = ids.get(key);
			if (found === undefined) throw new Error(`the world has no item ${key}`);
			return found;
		};
		for (const item of world.items) {
			const assignees = item.assignees ?? [];
			if (assignees.length > 1) throw new Error('an Azure DevOps work item has one assignee');
			ids.set(
				item.key,
				ado.workItem({
					type: (item.children ?? []).length > 0 ? 'Feature' : 'Product Backlog Item',
					title: item.title,
					...(item.body === undefined ? {} : { description: item.body }),
					...(assignees[0] === undefined ? {} : { assignedTo: assignees[0] }),
					tags: (item.signals ?? []).map((s) => names[s]),
					closed: item.open === false
				})
			);
		}
		for (const item of world.items) {
			for (const child of item.children ?? []) ado.addChild(id(item.key), id(child));
			for (const blocker of item.blockedBy ?? []) ado.precede(id(blocker), id(item.key));
			for (const c of item.comments ?? []) ado.say(id(item.key), c.author, c.body);
		}
		const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
		const list = trust === 'trusted list' ? world.trusted : undefined;
		const tracker = new AzureBoardsTracker(
			api,
			{ project: PROJECT, featureType: 'Feature' },
			names,
			list
		);
		return Promise.resolve({ tracker, id });
	};

describe('AzureBoardsTracker meets the Tracker contract', () => {
	describe("with the default Signal names and the project's Contributors as trust", () => {
		const harness = azureBoardsTracker(DEFAULT_SIGNAL_NAMES, 'Contributors');
		for (const c of trackerContract) it(c.name, () => c.run(harness));
	});

	describe("with factory.json's own Signal names and trusted list", () => {
		const harness = azureBoardsTracker(CONFIGURED, 'trusted list');
		for (const c of trackerContract) it(c.name, () => c.run(harness));
	});
});
