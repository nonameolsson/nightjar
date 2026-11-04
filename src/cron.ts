// A cron time as a schedule Source reads it: five fields (minute, hour, day of month, month, day of week) or @daily or @weekly, in the machine's local time zone.
export class CronError extends Error {}

export interface Cron {
	readonly minutes: ReadonlySet<number>;
	readonly hours: ReadonlySet<number>;
	readonly days: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	// 0 is Sunday; 7 is read as 0
	readonly weekdays: ReadonlySet<number>;
	// a day field that starts with `*`: with it, the day of month and the day of week must both match, else either
	readonly anyDay: boolean;
	readonly anyWeekday: boolean;
}

interface Field {
	readonly name: string;
	readonly min: number;
	readonly max: number;
}

const FIELDS: readonly Field[] = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day of month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12 },
	{ name: 'day of week', min: 0, max: 7 }
];

const NAMED: Readonly<Record<string, string>> = {
	'@daily': '0 0 * * *',
	'@weekly': '0 0 * * 0'
};

function number(text: string, field: Field): number {
	if (!/^\d+$/.test(text)) throw new CronError(`${field.name}: "${text}" is not a number`);
	const n = Number(text);
	if (n < field.min || n > field.max) {
		throw new CronError(
			`${field.name}: ${text} is not from ${String(field.min)} to ${String(field.max)}`
		);
	}
	return n;
}

function values(text: string, field: Field): Set<number> {
	const out = new Set<number>();
	for (const part of text.split(',')) {
		if (part === '') throw new CronError(`${field.name}: a list has an empty place`);
		const [range = '', step, ...extra] = part.split('/');
		if (extra.length > 0) throw new CronError(`${field.name}: "${part}" has two steps`);
		let from: number;
		let to: number;
		if (range === '*') {
			from = field.min;
			to = field.max;
		} else if (range.includes('-')) {
			const [a = '', b = '', ...more] = range.split('-');
			if (more.length > 0) throw new CronError(`${field.name}: "${range}" is not a range`);
			from = number(a, field);
			to = number(b, field);
			if (from > to) throw new CronError(`${field.name}: ${range} runs backwards`);
		} else {
			from = number(range, field);
			// a number with a step runs from there to the end, as in 5/15
			to = step === undefined ? from : field.max;
		}
		let by = 1;
		if (step !== undefined) {
			if (!/^\d+$/.test(step) || Number(step) < 1) {
				throw new CronError(`${field.name}: the step in "${part}" is not a number from 1`);
			}
			by = Number(step);
		}
		for (let n = from; n <= to; n += by) out.add(n);
	}
	return out;
}

// The cron time of an expression, or a CronError that says what is wrong with it.
export function parseCron(expression: string): Cron {
	const text = NAMED[expression.trim()] ?? expression.trim();
	if (text.startsWith('@')) {
		throw new CronError(`${text} is not known; use @daily or @weekly, or five fields`);
	}
	const parts = text.split(/\s+/);
	if (parts.length !== 5) {
		throw new CronError(
			`${String(parts.length === 1 && parts[0] === '' ? 0 : parts.length)} fields; a cron time has five: minute hour day-of-month month day-of-week`
		);
	}
	const [minute = '', hour = '', day = '', month = '', weekday = ''] = parts;
	const [fm, fh, fd, fo, fw] = FIELDS as readonly [Field, Field, Field, Field, Field];
	const weekdays = new Set([...values(weekday, fw)].map((n) => n % 7));
	const cron: Cron = {
		minutes: values(minute, fm),
		hours: values(hour, fh),
		days: values(day, fd),
		months: values(month, fo),
		weekdays,
		anyDay: day.startsWith('*'),
		anyWeekday: weekday.startsWith('*')
	};
	if (nextDue(cron, new Date(2026, 0, 1)) === null) {
		throw new CronError(`${expression.trim()} never comes due`);
	}
	return cron;
}

// how far ahead a time is looked for: enough for 29 February to come round, twice
const HORIZON_DAYS = 366 * 8;

function dayMatches(cron: Cron, day: Date): boolean {
	if (!cron.months.has(day.getMonth() + 1)) return false;
	const ofMonth = cron.days.has(day.getDate());
	const ofWeek = cron.weekdays.has(day.getDay());
	return cron.anyDay || cron.anyWeekday ? ofMonth && ofWeek : ofMonth || ofWeek;
}

// The first time after `after`, on the machine's local clock, that the cron time names; null when there is none in the next eight years.
export function nextDue(cron: Cron, after: Date): Date | null {
	const hours = [...cron.hours].sort((a, b) => a - b);
	const minutes = [...cron.minutes].sort((a, b) => a - b);
	for (let i = 0; i < HORIZON_DAYS; i += 1) {
		// a day by the calendar, so a change of clock never skips or doubles it
		const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i);
		if (!dayMatches(cron, day)) continue;
		for (const hour of hours) {
			for (const minute of minutes) {
				const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
				// a time the clock skips when it springs forward is not a time
				if (at.getHours() !== hour || at.getMinutes() !== minute) continue;
				if (at.getTime() > after.getTime()) return at;
			}
		}
	}
	return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

// A time as the machine's clock writes it, to the minute: 2026-11-09 06:00.
export function localTime(at: Date): string {
	const date = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
	return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// What is wrong with a cron time, or null when it is fine.
export function cronFault(expression: string): string | null {
	try {
		parseCron(expression);
		return null;
	} catch (fault) {
		if (fault instanceof CronError) return fault.message;
		throw fault;
	}
}
