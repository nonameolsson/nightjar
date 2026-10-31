// What the Azure Boards Tracker does beyond the contract, over a fake Azure DevOps.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_NAMES } from '../signals.js';
import { AzureDevOpsApi } from './api.js';
import { FakeAzureDevOps } from './fake-azure-devops.js';
import { AzureBoardsTracker } from './tracker.js';

const ANN = 'ann@contoso.com';

function setUp(trusted?: readonly string[]) {
	const ado = new FakeAzureDevOps('contoso', 'Fabrikam', ANN);
	const api = new AzureDevOpsApi('contoso', ado.signIn(), ado.request);
	const tracker = new AzureBoardsTracker(
		api,
		{ project: 'Fabrikam', featureType: 'Product Backlog Item' },
		DEFAULT_SIGNAL_NAMES,
		trusted
	);
	return { ado, tracker };
}

describe('AzureBoardsTracker', () => {
	it("never reads or sets a work item's state: a closed item is one Azure DevOps has stamped closed", async () => {
		const { ado, tracker } = setUp();
		const feature = ado.workItem({
			type: 'Product Backlog Item',
			title: 'Feature',
			assignedTo: ANN,
			tags: [DEFAULT_SIGNAL_NAMES.go],
			state: 'Removed'
		});
		const done = ado.workItem({ type: 'Task', title: 'Done', state: 'Active', closed: true });
		const open = ado.workItem({ type: 'Task', title: 'Open', state: 'Done' });
		ado.addChild(feature, done);
		ado.addChild(feature, open);
		ado.precede(done, open);
		ado.say(open, ANN, 'A question.');

		expect((await tracker.assignedFeatures(ANN)).map((f) => f.id)).toEqual([feature]);
		expect((await tracker.tickets(feature)).map((t) => [t.title, t.open, t.blockedBy])).toEqual([
			['Done', false, []],
			['Open', true, [{ id: done, open: false }]]
		]);
		await tracker.feature(feature);
		await tracker.comments(open);
		await tracker.addSignal(open, 'working');
		await tracker.removeSignal(open, 'working');
		await tracker.comment(open, 'An answer.');
		expect(ado.asked.length).toBeGreaterThan(0);
		for (const call of ado.asked) {
			expect(`${call.url} ${JSON.stringify(call.body)}`).not.toMatch(/state/i);
		}
	});

	it('references a Ticket as AB#<id>, which the Azure Boards app links from a pull request', () => {
		const { tracker } = setUp();
		expect(tracker.reference(42)).toEqual({ id: 42, text: 'AB#42' });
	});

	it('trusts the sign-in names on the trusted list in any case, and no Contributor besides', async () => {
		const { ado, tracker } = setUp(['Bob@Contoso.com']);
		ado.join('bob@contoso.com', { contributor: false });
		const id = ado.workItem({ type: 'Task', title: 'A Ticket' });
		ado.say(id, 'bob@contoso.com', 'Do it this way.');
		ado.say(id, ANN, 'No, that way.');
		expect((await tracker.comments(id)).map((c) => [c.author, c.trusted])).toEqual([
			['bob@contoso.com', true],
			[ANN, false]
		]);
	});

	it('asks again who is trusted after a read that failed, so one fault does not last the whole watch', async () => {
		const { ado, tracker } = setUp();
		const id = ado.workItem({ type: 'Task', title: 'A Ticket' });
		ado.say(id, ANN, 'Go on.');
		ado.failNext(/identities\?searchFilter/, 503);
		await expect(tracker.comments(id)).rejects.toThrow(/HTTP 503/);
		ado.failNext(/identities\?identityIds/, 503);
		await expect(tracker.comments(id)).rejects.toThrow(/HTTP 503/);
		expect((await tracker.comments(id)).map((c) => c.trusted)).toEqual([true]);
	});

	it('finds the Features of a person whose sign-in name holds a quote', async () => {
		const { ado, tracker } = setUp();
		const person = "o'neil@contoso.com";
		const feature = ado.workItem({
			type: 'Product Backlog Item',
			title: 'Theirs',
			assignedTo: person,
			tags: [DEFAULT_SIGNAL_NAMES.go]
		});
		ado.addChild(feature, ado.workItem({ type: 'Task', title: 'A Ticket' }));
		expect((await tracker.assignedFeatures(person)).map((f) => f.id)).toEqual([feature]);
	});

	it('reads a description written in the HTML editor as plain text, so its Model line still reads', async () => {
		const { ado, tracker } = setUp();
		const id = ado.workItem({
			type: 'Product Backlog Item',
			title: 'A spec',
			html: true,
			description:
				'<div>Build the <b>thing</b>.</div><div><br></div><div><b>Model:</b> opus</div>' +
				'<ul><li>one</li><li>two &amp; three &lt;four&gt;</li></ul>'
		});
		expect((await tracker.feature(id)).body).toBe(
			'Build the thing.\n\nModel: opus\n- one\n- two & three <four>'
		);
	});

	it('reads a comment written in the HTML editor as plain text, keeping where a link goes', async () => {
		const { ado, tracker } = setUp();
		const id = ado.workItem({ type: 'Task', title: 'A Ticket' });
		ado.say(id, ANN, '<div>Use the <a href="https://example.com/api">old API</a>.</div>', {
			html: true
		});
		expect((await tracker.comments(id)).map((c) => c.body)).toEqual([
			'Use the [old API](https://example.com/api).'
		]);
	});

	it.each([
		['Stack Rank', 'Microsoft.VSTS.Common.StackRank'],
		['Backlog Priority', 'Microsoft.VSTS.Common.BacklogPriority']
	])(
		'gives the Tickets in the order of the backlog, by %s, and those not yet ordered last, as linked',
		async (_name, field) => {
			const { ado, tracker } = setUp();
			const feature = ado.workItem({ type: 'Product Backlog Item', title: 'Feature' });
			const unranked = ado.workItem({ type: 'Task', title: 'Not ordered yet' });
			const second = ado.workItem({ type: 'Task', title: 'Second', rank: { field, value: 2000 } });
			const first = ado.workItem({ type: 'Task', title: 'First', rank: { field, value: 1000 } });
			const later = ado.workItem({ type: 'Task', title: 'Also not ordered' });
			for (const child of [unranked, second, first, later]) ado.addChild(feature, child);
			expect((await tracker.tickets(feature)).map((t) => t.title)).toEqual([
				'First',
				'Second',
				'Not ordered yet',
				'Also not ordered'
			]);
		}
	);
});
