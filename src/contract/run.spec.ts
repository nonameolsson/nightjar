// The runner behind `nightjar contract`: the contract suites over the harnesses a module exports.
import { describe, expect, it } from 'vitest';
import { fakeCodeHostHarness, fakeTrackerHarness } from '../fakes/harness.js';
import { assignContract } from './assign.js';
import { codeHostContract, type CodeHostHarness } from './code-host.js';
import { feedbackContract } from './feedback.js';
import { ContractRefusal, formatReport, runContract } from './run.js';
import { featureWriterContract } from './feature-writer.js';
import { trackerContract } from './tracker.js';
import { sourcesContract } from './sources.js';
import { ticketCountsContract } from './ticket-counts.js';
import { waitingOnContract } from './waiting-on.js';
import type { TrackerHarness } from './tracker.js';
import type { FakeCodeHost } from '../fakes/code-host.js';
import type { FakeTracker } from '../fakes/tracker.js';

// A Tracker that never knows who is signed in.
const forgetful: TrackerHarness = async (world) => {
	const subject = await fakeTrackerHarness(world);
	return { ...subject, tracker: Object.assign(subject.tracker, { me: () => Promise.resolve('') }) };
};

describe('runContract', () => {
	it('runs the Tracker suite over trackerHarness and the Code host suite over codeHostHarness', async () => {
		const report = await runContract({
			trackerHarness: fakeTrackerHarness,
			codeHostHarness: fakeCodeHostHarness
		});
		expect(report.suites.map((s) => s.title)).toEqual([
			'Tracker',
			'Tracker creation',
			'Tracker waiting on',
			'Tracker sources',
			'Tracker assign',
			'Tracker ticket counts',
			'Code host',
			'Code host feedback'
		]);
		expect(report.suites[0]?.results.map((r) => r.name)).toEqual(
			trackerContract.map((c) => c.name)
		);
		expect(report.suites[1]?.results.map((r) => r.name)).toEqual(
			featureWriterContract.map((c) => c.name)
		);
		expect(report.suites[2]?.results.map((r) => r.name)).toEqual(
			waitingOnContract.map((c) => c.name)
		);
		expect(report.suites[3]?.results.map((r) => r.name)).toEqual(
			sourcesContract.map((c) => c.name)
		);
		expect(report.suites[4]?.results.map((r) => r.name)).toEqual(assignContract.map((c) => c.name));
		expect(report.suites[5]?.results.map((r) => r.name)).toEqual(
			ticketCountsContract.map((c) => c.name)
		);
		expect(report.suites[6]?.results.map((r) => r.name)).toEqual(
			codeHostContract.map((c) => c.name)
		);
		expect(report.suites[7]?.results.map((r) => r.name)).toEqual(
			feedbackContract.map((c) => c.name)
		);
		expect(report.failed).toBe(0);
	});

	it('runs no feedback suite over a Code host without feedback and reply, as a module written before them', async () => {
		const reads: CodeHostHarness = async () => {
			const { codeHost, ...rest } = await fakeCodeHostHarness();
			const { feedback: _a, reply: _b, ...only } = codeHost as FakeCodeHost;
			return { ...rest, codeHost: only };
		};
		const report = await runContract({ codeHostHarness: reads });
		expect(report.suites.map((s) => s.title)).toEqual(['Code host']);
		expect(report.failed).toBe(0);
	});

	it('fails the feedback suite for a harness without a bench', async () => {
		const bare: CodeHostHarness = async () => {
			const { bench: _bench, ...rest } = await fakeCodeHostHarness();
			return rest;
		};
		const report = await runContract({ codeHostHarness: bare });
		const feedback = report.suites.find((s) => s.title === 'Code host feedback')?.results ?? [];
		expect(feedback).toHaveLength(feedbackContract.length);
		expect(feedback.every((r) => !r.ok)).toBe(true);
		expect(feedback[0]?.error).toContain('the harness gives a bench');
	});

	it('runs no creation suite over a Tracker that makes no Features, as a module written before it', async () => {
		const reads: TrackerHarness = async (world) => {
			const { tracker, ...rest } = await fakeTrackerHarness(world);
			const {
				createFeature: _a,
				createTicket: _b,
				block: _c,
				waitingOn: _d,
				featuresFrom: _e,
				assign: _f,
				trusts: _g,
				ticketCounts: _h,
				...only
			} = tracker as FakeTracker;
			return { ...rest, tracker: only };
		};
		const report = await runContract({ trackerHarness: reads });
		expect(report.suites.map((s) => s.title)).toEqual(['Tracker']);
		expect(report.failed).toBe(0);
	});

	it('runs no waitingOn suite over a Tracker without the method, and the creation suite still runs', async () => {
		const lacks: TrackerHarness = async (world) => {
			const { tracker, ...rest } = await fakeTrackerHarness(world);
			const { waitingOn: _gone, ...without } = tracker as FakeTracker;
			return { ...rest, tracker: without };
		};
		const report = await runContract({ trackerHarness: lacks });
		expect(report.suites.map((s) => s.title)).toEqual([
			'Tracker',
			'Tracker creation',
			'Tracker sources',
			'Tracker assign',
			'Tracker ticket counts'
		]);
		expect(report.failed).toBe(0);
	});

	it('runs no sources suite over a Tracker without featuresFrom', async () => {
		const lacks: TrackerHarness = async (world) => {
			const { tracker, ...rest } = await fakeTrackerHarness(world);
			const { featuresFrom: _gone, ...without } = tracker as FakeTracker;
			return { ...rest, tracker: without };
		};
		const report = await runContract({ trackerHarness: lacks });
		expect(report.suites.map((s) => s.title)).toEqual([
			'Tracker',
			'Tracker creation',
			'Tracker waiting on',
			'Tracker assign',
			'Tracker ticket counts'
		]);
		expect(report.failed).toBe(0);
	});

	it('runs no assign suite over a Tracker without assign', async () => {
		const lacks: TrackerHarness = async (world) => {
			const { tracker, ...rest } = await fakeTrackerHarness(world);
			const { assign: _gone, ...without } = tracker as FakeTracker;
			return { ...rest, tracker: without };
		};
		const report = await runContract({ trackerHarness: lacks });
		expect(report.suites.map((s) => s.title)).not.toContain('Tracker assign');
		expect(report.failed).toBe(0);
	});

	it('names an assign or trusts that is wrong', async () => {
		const wrong: TrackerHarness = async (world) => {
			const subject = await fakeTrackerHarness(world);
			return {
				...subject,
				tracker: Object.assign(subject.tracker, {
					assign: () => Promise.resolve(),
					trusts: () => Promise.resolve(true)
				})
			};
		};
		const report = await runContract({ trackerHarness: wrong });
		const failing = report.suites.find((s) => s.title === 'Tracker assign')?.results ?? [];
		expect(failing.filter((r) => !r.ok).map((r) => r.name)).toEqual(
			assignContract.map((c) => c.name)
		);
	});

	it('names a featuresFrom that is wrong', async () => {
		const wrong: TrackerHarness = async (world) => {
			const subject = await fakeTrackerHarness(world);
			return {
				...subject,
				tracker: Object.assign(subject.tracker, { featuresFrom: () => Promise.resolve([]) })
			};
		};
		const report = await runContract({ trackerHarness: wrong });
		const failing = report.suites.find((s) => s.title === 'Tracker sources')?.results ?? [];
		expect(failing.filter((r) => !r.ok).map((r) => r.name)).toEqual([
			sourcesContract[0]?.name,
			sourcesContract[2]?.name
		]);
	});

	it('names a waitingOn that is wrong', async () => {
		const wrong: TrackerHarness = async (world) => {
			const subject = await fakeTrackerHarness(world);
			return {
				...subject,
				tracker: Object.assign(subject.tracker, { waitingOn: () => Promise.resolve([]) })
			};
		};
		const report = await runContract({ trackerHarness: wrong });
		const failing = report.suites.find((s) => s.title === 'Tracker waiting on')?.results ?? [];
		expect(failing.every((r) => !r.ok)).toBe(true);
		expect(failing).toHaveLength(waitingOnContract.length);
	});

	it('names a ticketCounts that miscounts or drops a Feature', async () => {
		const wrong = (answer: () => Map<string, { total: number; closed: number } | null>) => {
			const harness: TrackerHarness = async (world) => {
				const subject = await fakeTrackerHarness(world);
				return {
					...subject,
					tracker: Object.assign(subject.tracker, { ticketCounts: () => Promise.resolve(answer()) })
				};
			};
			return harness;
		};
		for (const answer of [
			() => new Map<string, { total: number; closed: number } | null>(),
			() => new Map([['1', { total: 9, closed: 9 }]])
		]) {
			const report = await runContract({ trackerHarness: wrong(answer) });
			const suite = report.suites.find((s) => s.title === 'Tracker ticket counts')?.results ?? [];
			expect(suite.filter((r) => !r.ok).length).toBeGreaterThan(0);
		}
	});

	it('runs only the suite whose harness the module exports', async () => {
		const report = await runContract({ codeHostHarness: fakeCodeHostHarness });
		expect(report.suites.map((s) => s.title)).toEqual(['Code host', 'Code host feedback']);
	});

	it('names each behaviour that fails, with why, and keeps going', async () => {
		const report = await runContract({ trackerHarness: forgetful });
		const failing = report.suites[0]?.results.filter((r) => !r.ok) ?? [];
		// comments as the signed-in person also reads who that is
		expect(failing.map((r) => r.name)).toEqual([
			'names the signed-in person',
			'comments as the signed-in person, below the comments already there, with the body unchanged'
		]);
		expect(failing[0]?.error).toContain('Expected values to be strictly equal');
		expect(report.failed).toBe(2);
		expect(report.total).toBe(
			trackerContract.length +
				featureWriterContract.length +
				waitingOnContract.length +
				sourcesContract.length +
				assignContract.length +
				ticketCountsContract.length
		);
		const text = formatReport(report);
		expect(text).toContain('FAIL  names the signed-in person');
		expect(text).toContain('ok    lists the open Features assigned to a person');
		expect(text).toContain(`2 of ${String(report.total)} behaviours fail.`);
	});

	it('counts a harness that throws as a failure of the behaviour it was building for', async () => {
		const report = await runContract({
			trackerHarness: () => Promise.reject(new Error('no server to reach'))
		});
		expect(report.failed).toBe(trackerContract.length);
		expect(formatReport(report)).toContain('no server to reach');
	});

	it('refuses a module that exports no harness, saying which exports it looks for', async () => {
		await expect(runContract({ other: 1 })).rejects.toThrow(ContractRefusal);
		await expect(runContract({ other: 1 })).rejects.toThrow(
			'exports neither trackerHarness nor codeHostHarness'
		);
	});

	it('refuses a harness that is not a function', async () => {
		await expect(runContract({ trackerHarness: {} })).rejects.toThrow(
			'exports trackerHarness, which is not a function'
		);
	});
});
