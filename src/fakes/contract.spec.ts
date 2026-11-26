// The in-memory fakes against the Adapter contract suites, taken from the package's own entry.
import { describe, it } from 'vitest';
import {
	assignContract,
	botPullsContract,
	codeHostContract,
	featureWriterContract,
	nightjarDraftsContract,
	openPullsContract,
	publishContract,
	sourcesContract,
	feedbackContract,
	shelfContract,
	statusNoteContract,
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

describe('FakeTracker meets the featuresFrom contract', () => {
	for (const c of sourcesContract) it(c.name, () => c.run(fakeTrackerHarness));
});

describe('FakeTracker meets the assign contract', () => {
	for (const c of assignContract) it(c.name, () => c.run(fakeTrackerHarness));
});

describe('FakeTracker meets the ticketCounts contract', () => {
	for (const c of ticketCountsContract) it(c.name, () => c.run(fakeTrackerHarness));
});

describe('FakeTracker meets the shelf contract', () => {
	for (const c of shelfContract) it(c.name, () => c.run(fakeTrackerHarness));
});

describe('FakeTracker meets the statusNote contract', () => {
	for (const c of statusNoteContract) it(c.name, () => c.run(fakeTrackerHarness));
});

describe('FakeTracker keyed as PROJ-N meets the Tracker, creation, waitingOn, featuresFrom, assign, ticketCounts, shelf and statusNote contracts', () => {
	const keyed = keyedTrackerHarness('PROJ-');
	for (const c of [
		...trackerContract,
		...featureWriterContract,
		...waitingOnContract,
		...sourcesContract,
		...assignContract,
		...ticketCountsContract,
		...shelfContract,
		...statusNoteContract
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

describe('FakeCodeHost meets the feedback contract', () => {
	for (const c of feedbackContract) it(c.name, () => c.run(fakeCodeHostHarness));
});

describe('FakeCodeHost meets the openPulls contract', () => {
	for (const c of openPullsContract) it(c.name, () => c.run(fakeCodeHostHarness));
});

describe('FakeCodeHost meets the publish contract', () => {
	for (const c of publishContract) it(c.name, () => c.run(fakeCodeHostHarness));
});

describe('FakeCodeHost meets the botPulls contract', () => {
	for (const c of botPullsContract) it(c.name, () => c.run(fakeCodeHostHarness));
});
