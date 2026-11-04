// The in-memory fakes against the Adapter contract suites, taken from the package's own entry.
import { describe, it } from 'vitest';
import {
	codeHostContract,
	featureWriterContract,
	nightjarDraftsContract,
	ticketCountsContract,
	trackerContract,
	waitingOnContract
} from '../index.js';
import { fakeCodeHostHarness, fakeTrackerHarness, keyedTrackerHarness } from './harness.js';

describe('FakeTracker meets the Tracker contract', () => {
	for (const c of trackerContract) it(c.name, () => c.run(fakeTrackerHarness));
});

describe('FakeTracker meets the creation contract', () => {
	for (const c of featureWriterContract) it(c.name, () => c.run(fakeTrackerHarness));
});

describe('FakeTracker meets the waitingOn contract', () => {
	for (const c of waitingOnContract) it(c.name, () => c.run(fakeTrackerHarness));
});

describe('FakeTracker meets the ticketCounts contract', () => {
	for (const c of ticketCountsContract) it(c.name, () => c.run(fakeTrackerHarness));
});

describe('FakeTracker keyed as PROJ-N meets the Tracker, creation, waitingOn and ticketCounts contracts', () => {
	const keyed = keyedTrackerHarness('PROJ-');
	for (const c of [
		...trackerContract,
		...featureWriterContract,
		...waitingOnContract,
		...ticketCountsContract
	]) {
		it(c.name, () => c.run(keyed));
	}
});

describe('FakeCodeHost meets the Code host contract', () => {
	for (const c of codeHostContract) it(c.name, () => c.run(fakeCodeHostHarness));
});

describe('FakeCodeHost meets the nightjarDrafts contract', () => {
	for (const c of nightjarDraftsContract) it(c.name, () => c.run(fakeCodeHostHarness));
});
