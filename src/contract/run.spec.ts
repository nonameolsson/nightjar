// The runner behind `nightjar contract`: the contract suites over the harnesses a module exports.
import { describe, expect, it } from 'vitest';
import { fakeCodeHostHarness, fakeTrackerHarness } from '../fakes/harness.js';
import { codeHostContract } from './code-host.js';
import { ContractRefusal, formatReport, runContract } from './run.js';
import { featureWriterContract } from './feature-writer.js';
import { trackerContract } from './tracker.js';
import type { TrackerHarness } from './tracker.js';
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
		expect(report.suites.map((s) => s.title)).toEqual(['Tracker', 'Tracker creation', 'Code host']);
		expect(report.suites[0]?.results.map((r) => r.name)).toEqual(
			trackerContract.map((c) => c.name)
		);
		expect(report.suites[1]?.results.map((r) => r.name)).toEqual(
			featureWriterContract.map((c) => c.name)
		);
		expect(report.suites[2]?.results.map((r) => r.name)).toEqual(
			codeHostContract.map((c) => c.name)
		);
		expect(report.failed).toBe(0);
	});

	it('runs no creation suite over a Tracker that makes no Features, as a module written before it', async () => {
		const reads: TrackerHarness = async (world) => {
			const { tracker, ...rest } = await fakeTrackerHarness(world);
			const { createFeature: _a, createTicket: _b, block: _c, ...only } = tracker as FakeTracker;
			return { ...rest, tracker: only };
		};
		const report = await runContract({ trackerHarness: reads });
		expect(report.suites.map((s) => s.title)).toEqual(['Tracker']);
		expect(report.failed).toBe(0);
	});

	it('runs only the suite whose harness the module exports', async () => {
		const report = await runContract({ codeHostHarness: fakeCodeHostHarness });
		expect(report.suites.map((s) => s.title)).toEqual(['Code host']);
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
		expect(report.total).toBe(trackerContract.length + featureWriterContract.length);
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
