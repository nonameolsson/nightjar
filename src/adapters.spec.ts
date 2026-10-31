// The Tracker makeAdapters builds speaks the trust factory.json gives it.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAdapters } from './adapters.js';
import type { Config } from './config.js';
import { DEFAULT_SIGNAL_NAMES } from './signals.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'nightjar-adapters-'));
	// a gh whose only comment is by bob, who has write access
	const gh = join(dir, 'gh');
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
case "$*" in
  *permission*) echo '{"permission":"write"}' ;;
  *comments*) echo '[{"body":"hi","user":{"login":"bob"},"created_at":"2026-10-30T09:00:00Z","author_association":"NONE"}]' ;;
  *) echo '[]' ;;
esac`
	);
	chmodSync(gh, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (over: Partial<Config>): Config => ({
	tracker: { type: 'github', repo: 'o/r' },
	codeHost: { type: 'github', repo: 'o/r' },
	check: 'make check',
	allowedCommands: [],
	signals: DEFAULT_SIGNAL_NAMES,
	...over
});

const env = () => ({ ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` });

describe('makeAdapters', () => {
	it('trusts a writer by default', async () => {
		const { tracker } = await makeAdapters(config({}), dir, env());
		expect((await tracker.comments(1)).map((c) => c.trusted)).toEqual([true]);
	});

	it("trusts only the config's trusted list when it has one", async () => {
		const { tracker } = await makeAdapters(config({ trusted: ['ann'] }), dir, env());
		expect((await tracker.comments(1)).map((c) => c.trusted)).toEqual([false]);
	});
});
