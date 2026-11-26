import { describe, expect, it } from 'vitest';
import { lastWeek, NO_WEEK, weekOf, type WeekSource } from './last-week.js';

// Fri 30 Oct 2026, 09:00 local: the week is Sat 24 Oct 00:00 up to Sat 31 Oct 00:00
const now = new Date(2026, 9, 30, 9, 0);
const local = (day: number, hour = 12, month = 9) => new Date(2026, month, day, hour, 0);

const source = (parts: Partial<WeekSource>): WeekSource => ({
	sessions: [],
	outcomes: [],
	handedBack: [],
	...parts
});

describe('the last seven days', () => {
	it('is today and the six local days before it, midnight to midnight', () => {
		const { from, until } = weekOf(now);
		expect(new Date(from)).toEqual(local(24, 0));
		expect(new Date(until)).toEqual(local(31, 0));
	});

	it('counts nothing for nothing', () => {
		expect(lastWeek(source({}), now)).toEqual(NO_WEEK);
	});

	it('sums the Sessions of the seven local days and no others', () => {
		const session = (at: Date, costUsd: number) => ({ at: at.getTime(), costUsd });
		const week = lastWeek(
			source({
				sessions: [
					// the evening before the week, and the morning after it
					session(local(23, 23), 100),
					session(local(31, 0), 200),
					session(local(24, 0), 1),
					session(local(27), 2),
					session(local(30, 23), 4),
					// a line whose time does not read
					{ at: Number.NaN, costUsd: 400 }
				]
			}),
			now
		);
		expect(week.spentUsd).toBe(7);
	});

	it('counts a Feature once, by how it last ended in the week', () => {
		const week = lastWeek(
			source({
				outcomes: [
					// failed and then mended: a completion
					{ feature: '1', kind: 'failed', at: local(25).toISOString() },
					{ feature: '1', kind: 'pull', at: local(26).toISOString() },
					// completed and then failed again
					{ feature: '2', kind: 'pull', at: local(25).toISOString() },
					{ feature: '2', kind: 'failed', at: local(28).toISOString() },
					{ feature: '3', kind: 'pull', at: local(29).toISOString() },
					{ feature: '4', kind: 'failed', at: local(29).toISOString() },
					// before the week
					{ feature: '5', kind: 'pull', at: local(23, 23).toISOString() },
					// a Feature whose earlier run is outside the week keeps only its run inside it
					{ feature: '6', kind: 'failed', at: local(20).toISOString() },
					{ feature: '6', kind: 'pull', at: local(30, 8).toISOString() }
				]
			}),
			now
		);
		expect(week.completed).toBe(3);
		expect(week.failed).toBe(2);
	});

	it('counts a Feature by its latest run in the week, whatever order the runs come in, and a run read twice once', () => {
		const week = lastWeek(
			source({
				outcomes: [
					// the Logbook's runs, then status.json's of the same Feature
					{ feature: '1', kind: 'failed', at: local(28).toISOString() },
					{ feature: '1', kind: 'pull', at: local(25).toISOString() },
					{ feature: '1', kind: 'failed', at: local(28).toISOString() },
					{ feature: '2', kind: 'pull', at: local(26).toISOString() },
					{ feature: '2', kind: 'pull', at: local(26).toISOString() }
				]
			}),
			now
		);
		expect(week.completed).toBe(1);
		expect(week.failed).toBe(1);
	});

	it('counts the Features handed to a person, a Feature and its Tickets as one', () => {
		const week = lastWeek(
			source({
				handedBack: [
					{ feature: '1', at: local(25).toISOString() },
					{ feature: '1', at: local(26).toISOString() },
					{ feature: '2', at: local(30, 1).toISOString() },
					{ feature: '3', at: local(23, 23).toISOString() },
					{ feature: '4', at: 'not a time' }
				]
			}),
			now
		);
		expect(week.handed).toBe(2);
	});

	it('counts a Feature that failed as failed alone, though Nightjar handed it back too', () => {
		const week = lastWeek(
			source({
				outcomes: [{ feature: '1', kind: 'failed', at: local(28).toISOString() }],
				handedBack: [
					{ feature: '1', at: local(28).toISOString() },
					{ feature: '2', at: local(28).toISOString() }
				]
			}),
			now
		);
		expect([week.failed, week.handed]).toEqual([1, 1]);
	});

	it('counts the local day, across the month boundary', () => {
		const early = new Date(2026, 10, 2, 8, 0);
		const week = lastWeek(
			source({
				sessions: [
					{ at: new Date(2026, 9, 27, 12).getTime(), costUsd: 1 },
					{ at: new Date(2026, 9, 26, 12).getTime(), costUsd: 10 }
				]
			}),
			early
		);
		// Nov 2 reaches back to Oct 27
		expect(week.spentUsd).toBe(1);
	});
});
