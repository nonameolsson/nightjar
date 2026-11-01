// What the status line and the toasts say, from .factory/status.json (shape: src/status-shape.ts).
import type { Event, Status } from '../../../src/status-shape.js';

const two = (n: number) => String(n).padStart(2, '0');
const clock = (iso: string) => {
	const d = new Date(iso);
	return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const minutes = (from: string, nowMs: number) =>
	`${String(Math.max(0, Math.round((nowMs - Date.parse(from)) / 60_000)))}m`;
const sameDay = (iso: string, nowMs: number) =>
	new Date(iso).toDateString() === new Date(nowMs).toDateString();

// The status line, or undefined when Nightjar is off.
export function line(status: Status, nowMs: number): string | undefined {
	const said = what(status, nowMs);
	if (said === undefined || !status.codeMoved) return said;
	return `${said} · restart: main has new Nightjar code (${status.codeMoved})`;
}

function what(status: Status, nowMs: number): string | undefined {
	const d = status.doing;
	// the file keeps yesterday's spend until Nightjar writes again
	const spent = sameDay(status.at, nowMs) ? status.spentTodayUsd : 0;
	const today = `$${spent.toFixed(2)} today`;
	if (d.kind === 'off') return undefined;
	if (d.kind === 'idle') return `nightjar: idle, next poll ${clock(d.nextPollAt)} · ${today}`;
	if (d.kind === 'paused') {
		const until = d.until ? ` until ${clock(d.until)}` : '';
		return `nightjar: paused${until}: ${d.why} · ${today}`;
	}
	const where = d.ticket === null ? `#${d.feature}` : `#${d.feature} › #${d.ticket}`;
	const round =
		d.round !== null && d.rounds !== null && (d.step === 'fix' || d.round > 1)
			? ` ${String(d.round)}/${String(d.rounds)}`
			: '';
	return `nightjar: ${where} ${d.step}${round} · ${minutes(d.startedAt, nowMs)} · ${today}`;
}

export function toast(e: Event): string {
	if (e.kind === 'built') return `nightjar: #${e.ticket} built (#${e.feature})`;
	if (e.kind === 'pull') return `nightjar: #${e.feature} draft pull request ${e.url}`;
	if (e.kind === 'failed') return `nightjar: #${e.feature} failed: ${e.why}`;
	if (e.kind === 'stale') {
		return `nightjar: main has new Nightjar code (${e.commit}); restart it from an updated main`;
	}
	return `nightjar: #${e.ticket ?? e.feature} needs a person: ${e.why}`;
}
