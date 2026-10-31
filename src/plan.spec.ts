import { describe, expect, it } from 'vitest';
import { nextTicket, waiting } from './plan.js';
import type { Ticket } from './tracker.js';

const ticket = (id: number, over: Partial<Ticket> = {}): Ticket => ({
	id,
	title: `Ticket ${String(id)}`,
	body: '',
	open: true,
	signals: ['ready'],
	blockedBy: [],
	...over
});

describe('nextTicket', () => {
	it('takes the first ready Ticket, in the order the Feature lists them', () => {
		expect(nextTicket([ticket(7), ticket(5)], new Set())?.id).toBe(7);
	});

	it('skips a Ticket whose blocker is still open and not built', () => {
		const tickets = [ticket(2, { blockedBy: [{ id: 1, open: true }] }), ticket(3)];
		expect(nextTicket(tickets, new Set())?.id).toBe(3);
	});

	it('takes a Ticket whose open blocker was built on this branch', () => {
		const tickets = [ticket(2, { blockedBy: [{ id: 1, open: true }] })];
		expect(nextTicket(tickets, new Set([1]))?.id).toBe(2);
	});

	it('takes a Ticket whose blocker is closed', () => {
		const tickets = [ticket(2, { blockedBy: [{ id: 1, open: false }] })];
		expect(nextTicket(tickets, new Set())?.id).toBe(2);
	});

	it('never takes a closed Ticket, a built one, or one not marked ready', () => {
		const tickets = [ticket(1, { open: false }), ticket(2), ticket(3, { signals: ['needsInfo'] })];
		expect(nextTicket(tickets, new Set([2]))).toBeNull();
	});
});

describe('waiting', () => {
	it('names each open Ticket left unbuilt, with why', () => {
		const tickets = [
			ticket(1),
			ticket(2, { signals: ['needsInfo'] }),
			ticket(3, { signals: ['human'] }),
			ticket(4, { blockedBy: [{ id: 2, open: true }] }),
			ticket(5, { signals: [] }),
			ticket(6, { open: false })
		];
		expect(waiting(tickets, new Set([1]))).toEqual([
			{ id: 2, title: 'Ticket 2', why: 'needs info' },
			{ id: 3, title: 'Ticket 3', why: 'needs a person' },
			{ id: 4, title: 'Ticket 4', why: 'blocked by', blocker: 2 },
			{ id: 5, title: 'Ticket 5', why: 'not marked ready' }
		]);
	});
});
