// The cron reader of a schedule Source, over an injected clock: every time is the machine's local time.
import { describe, expect, it } from 'vitest';
import { CronError, cronFault, localTime, nextDue, parseCron } from './cron.js';

// 2026-11-03 is a Tuesday
const TUESDAY_NOON = new Date(2026, 10, 3, 12, 0);

const next = (expression: string, after: Date = TUESDAY_NOON) => {
	const at = nextDue(parseCron(expression), after);
	return at === null ? null : localTime(at);
};

describe('a cron time of five fields', () => {
	it('fires at the minute and hour it names', () => {
		expect(next('30 14 * * *')).toBe('2026-11-03 14:30');
		// today's time has passed, so tomorrow's
		expect(next('30 9 * * *')).toBe('2026-11-04 09:30');
	});

	it('is never the time it is asked from, only one after it', () => {
		expect(next('0 12 * * *')).toBe('2026-11-04 12:00');
		expect(next('1 12 * * *')).toBe('2026-11-03 12:01');
		// seconds into the minute count: 12:00:30 is past 12:00
		expect(next('0 12 * * *', new Date(2026, 10, 3, 11, 59, 30))).toBe('2026-11-03 12:00');
		expect(next('0 12 * * *', new Date(2026, 10, 3, 12, 0, 30))).toBe('2026-11-04 12:00');
	});

	it('takes * in every field', () => {
		expect(next('* * * * *')).toBe('2026-11-03 12:01');
	});

	it('takes a day of the month, a month and a day of the week', () => {
		expect(next('0 6 15 * *')).toBe('2026-11-15 06:00');
		expect(next('0 6 1 1 *')).toBe('2027-01-01 06:00');
		// 1 is Monday
		expect(next('0 6 * * 1')).toBe('2026-11-09 06:00');
		expect(next('0 6 * * 0')).toBe('2026-11-08 06:00');
		// 7 is Sunday too
		expect(next('0 6 * * 7')).toBe('2026-11-08 06:00');
	});

	it('takes ranges', () => {
		expect(next('0 9-17 * * *', new Date(2026, 10, 3, 18, 0))).toBe('2026-11-04 09:00');
		expect(next('0 9-17 * * *')).toBe('2026-11-03 13:00');
		// Monday to Friday, from a Friday evening
		expect(next('0 6 * * 1-5', new Date(2026, 10, 6, 18, 0))).toBe('2026-11-09 06:00');
	});

	it('takes lists', () => {
		expect(next('0,30 12 * * *')).toBe('2026-11-03 12:30');
		expect(next('0 6 1,15 * *')).toBe('2026-11-15 06:00');
		// Tuesday's 06:00 has passed, so Thursday's
		expect(next('0 6 * * 2,4')).toBe('2026-11-05 06:00');
	});

	it('takes steps over * and over ranges', () => {
		expect(next('*/15 * * * *', new Date(2026, 10, 3, 12, 16))).toBe('2026-11-03 12:30');
		expect(next('*/20 12 * * *')).toBe('2026-11-03 12:20');
		expect(next('10-40/15 13 * * *')).toBe('2026-11-03 13:10');
		expect(next('10-40/15 13 * * *', new Date(2026, 10, 3, 13, 10))).toBe('2026-11-03 13:25');
		expect(next('0 */6 * * *')).toBe('2026-11-03 18:00');
		// a number with a step runs from there to the end
		expect(next('50/5 12 * * *')).toBe('2026-11-03 12:50');
	});

	it('takes a list of ranges with steps', () => {
		expect(next('0 0-6/3,20 * * *')).toBe('2026-11-03 20:00');
	});

	it('fires on the day of the month or the day of the week when both are named', () => {
		// the 10th, or any Monday: Tuesday the 3rd is followed by Monday the 9th
		expect(next('0 6 10 * 1')).toBe('2026-11-09 06:00');
		expect(next('0 6 10 * 1', new Date(2026, 10, 9, 7, 0))).toBe('2026-11-10 06:00');
	});

	it('needs both when the day of the month or the week is a *', () => {
		// */2 is the odd days of the month: Monday the 9th is one, Monday the 16th is not
		expect(next('0 6 */2 * 1')).toBe('2026-11-09 06:00');
		expect(next('0 6 */2 * 1', new Date(2026, 10, 10, 0, 0))).toBe('2026-11-23 06:00');
	});

	it('finds 29 February years ahead', () => {
		expect(next('0 0 29 2 *')).toBe('2028-02-29 00:00');
	});

	it('reads the clock of the machine, a day at a time', () => {
		const at = nextDue(parseCron('0 6 * * *'), new Date(2026, 11, 31, 23, 0));
		expect(at).toEqual(new Date(2027, 0, 1, 6, 0));
	});
});

describe('@daily and @weekly', () => {
	it('@daily is midnight every day', () => {
		expect(next('@daily')).toBe('2026-11-04 00:00');
		expect(next('@daily', new Date(2026, 10, 3, 0, 0))).toBe('2026-11-04 00:00');
		expect(next('@daily', new Date(2026, 10, 2, 23, 59))).toBe('2026-11-03 00:00');
	});

	it('@weekly is midnight on Sunday', () => {
		expect(next('@weekly')).toBe('2026-11-08 00:00');
		expect(next('@weekly', new Date(2026, 10, 8, 0, 0))).toBe('2026-11-15 00:00');
	});
});

describe('a cron time that is wrong', () => {
	const refused: Record<string, RegExp> = {
		'': /0 fields/,
		'0 6 * *': /4 fields/,
		'0 6 * * * *': /6 fields/,
		'@hourly': /@hourly is not known/,
		'x * * * *': /minute: "x" is not a number/,
		'60 * * * *': /minute: 60 is not from 0 to 59/,
		'* 24 * * *': /hour: 24 is not from 0 to 23/,
		'* * 0 * *': /day of month: 0 is not from 1 to 31/,
		'* * * 0 *': /month: 0 is not from 1 to 12/,
		'* * * * 8': /day of week: 8 is not from 0 to 7/,
		'5-1 * * * *': /minute: 5-1 runs backwards/,
		'1-2-3 * * * *': /minute: "1-2-3" is not a range/,
		'*/0 * * * *': /the step in "\*\/0"/,
		'*/x * * * *': /the step in "\*\/x"/,
		'1//2 * * * *': /two steps/,
		'1,,2 * * * *': /empty place/,
		'0 0 30 2 *': /never comes due/
	};

	for (const [expression, why] of Object.entries(refused)) {
		it(`refuses "${expression}"`, () => {
			expect(() => parseCron(expression)).toThrow(CronError);
			expect(() => parseCron(expression)).toThrow(why);
			expect(cronFault(expression)).toMatch(why);
		});
	}

	it('has no fault when it is right', () => {
		expect(cronFault('0 6 * * 1')).toBeNull();
		expect(cronFault('@weekly')).toBeNull();
	});
});

describe('localTime', () => {
	it('writes the date and the minute, padded', () => {
		expect(localTime(new Date(2026, 0, 5, 7, 4))).toBe('2026-01-05 07:04');
	});
});
