// The in-memory fakes against the Adapter contract suites, taken from the package's own entry.
import { describe, it } from 'vitest';
import {
	codeHostContract,
	featureWriterContract,
	feedbackContract,
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

describe('FakeTracker keyed as PROJ-N meets the Tracker, creation and waitingOn contracts', () => {
	const keyed = keyedTrackerHarness('PROJ-');
	for (const c of [...trackerContract, ...featureWriterContract, ...waitingOnContract]) {
		it(c.name, () => c.run(keyed));
	}
});

describe('FakeCodeHost meets the Code host contract', () => {
	for (const c of codeHostContract) it(c.name, () => c.run(fakeCodeHostHarness));
});

describe('FakeCodeHost meets the feedback contract', () => {
	for (const c of feedbackContract) it(c.name, () => c.run(fakeCodeHostHarness));
});
