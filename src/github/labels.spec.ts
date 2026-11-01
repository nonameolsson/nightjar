// The labels a GitHub Tracker shows the Signals as, created once and never overwritten.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_NAMES } from '../signals.js';
import { failed, fakeGh, ok, on } from './fake-gh.js';
import { GitHubFailure } from './api.js';
import { createSignalLabels } from './labels.js';

describe('createSignalLabels', () => {
	it('creates one label for each Signal name, with a description', async () => {
		const { gh, calls } = fakeGh(on('POST', 'repos/o/r/labels', ok({})));
		const said = await createSignalLabels(gh, 'o/r', DEFAULT_SIGNAL_NAMES);
		expect(calls.map((c) => c.fields.name)).toEqual([
			'factory-go',
			'ready-for-agent',
			'agent-working',
			'needs-info',
			'ready-for-human'
		]);
		expect(calls[0]?.fields.description).toMatch(/^Nightjar: /);
		expect(said).toContain('created the label factory-go');
		expect(said).toHaveLength(5);
	});

	it('leaves a label that exists as it is', async () => {
		const { gh, calls } = fakeGh(
			on('POST', 'repos/o/r/labels', (call) =>
				call.fields.name === 'ready-for-agent' ? failed('gh: Validation Failed (HTTP 422)') : ok({})
			),
			on('GET', 'repos/o/r/labels/ready-for-agent', ok({ name: 'ready-for-agent' }))
		);
		const said = await createSignalLabels(gh, 'o/r', DEFAULT_SIGNAL_NAMES);
		expect(said).toContain('the label ready-for-agent exists already');
		expect(calls.filter((c) => c.method !== 'POST' && c.method !== 'GET')).toEqual([]);
	});

	it('makes one label of two Signals that share a name', async () => {
		const { gh, calls } = fakeGh(on('POST', 'repos/o/r/labels', ok({})));
		await createSignalLabels(gh, 'o/r', { ...DEFAULT_SIGNAL_NAMES, go: 'ready-for-agent' });
		expect(calls.map((c) => c.fields.name)).toEqual([
			'ready-for-agent',
			'agent-working',
			'needs-info',
			'ready-for-human'
		]);
	});

	it('names the label gh could not create, and why', async () => {
		const { gh } = fakeGh(
			on('POST', 'repos/o/r/labels', failed('gh: Resource not accessible (HTTP 403)'))
		);
		await expect(createSignalLabels(gh, 'o/r', DEFAULT_SIGNAL_NAMES)).rejects.toThrow(
			new GitHubFailure(
				'gh could not create the label factory-go: gh: Resource not accessible (HTTP 403)'
			)
		);
	});

	it('does not take a 422 for an existing label when the label is not there', async () => {
		const { gh } = fakeGh(
			on('POST', 'repos/o/r/labels', failed('gh: Validation Failed (HTTP 422)'))
		);
		await expect(createSignalLabels(gh, 'o/r', DEFAULT_SIGNAL_NAMES)).rejects.toThrow(
			/gh could not create the label factory-go: gh: Validation Failed \(HTTP 422\)/
		);
	});
});
