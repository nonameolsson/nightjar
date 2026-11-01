// `nightjar create FILE` end to end, with a stand-in for gh first on PATH.
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PACKAGE = join(import.meta.dirname, '..');
const TSX = join(PACKAGE, 'node_modules', '.bin', 'tsx');
const CLI = join(PACKAGE, 'src', 'cli.ts');

let base: string;
beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-create-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

// gh: opens issues numbered from 1, each with the id 1000 + its number; every call is kept in $FAKE_GH_CALLS
const GH = String.raw`
printf '%s\n' "$*" >> "$FAKE_GH_CALLS"
issue() { printf '{"id":%s,"number":%s,"title":"t","body":"","state":"open","labels":[],"user":{"login":"ann"}}' "$((1000 + $1))" "$1"; }
case "$*" in
  "api -X POST repos/o/r/issues "*)
    n=$(( $(cat "$FAKE_GH_COUNT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_GH_COUNT"
    [ -n "$FAKE_GH_FAIL_AT" ] && [ "$n" = "$FAKE_GH_FAIL_AT" ] && { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }
    issue "$n"; exit 0 ;;
  "api repos/o/r/issues/"*) all="$*"; issue "${'$'}{all##*/}"; exit 0 ;;
  *sub_issues*|*dependencies/blocked_by*) echo '{}'; exit 0 ;;
  *labels*) echo '[]'; exit 0 ;;
esac
echo "gh: Not Found (HTTP 404)" >&2; exit 1`;

const FILE = `# Share one HTML escape

Two renderers escape HTML their own way.

## Ticket 1: Move the escape into one module

**Model:** opus

### Acceptance criteria

- [ ] one module exports escapeHtml

## Ticket 2: Use it in the comment renderer

**Blocked by:** 1

### Acceptance criteria

- [ ] comments escape through it
`;

function world(tracker: Record<string, unknown> = { type: 'github', repo: 'o/r' }) {
	const bin = join(base, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\n${GH}\n`);
	chmodSync(join(bin, 'gh'), 0o755);
	const env: Record<string, string> = {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				(e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('GIT_')
			)
		),
		PATH: `${bin}:${process.env.PATH ?? ''}`,
		HOME: join(base, 'home'),
		GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
		GIT_CONFIG_NOSYSTEM: '1',
		FAKE_GH_CALLS: join(base, 'gh-calls.txt'),
		FAKE_GH_COUNT: join(base, 'gh-count.txt')
	};
	writeFileSync(env.GIT_CONFIG_GLOBAL ?? '', '');
	const root = join(base, 'app');
	mkdirSync(join(root, 'plans'), { recursive: true });
	spawnSync('git', ['init', '-q', root], { env });
	const config = {
		tracker,
		codeHost: { type: 'github', repo: 'o/r' },
		check: 'make check',
		allowedCommands: []
	};
	writeFileSync(join(root, 'factory.json'), JSON.stringify(config));
	writeFileSync(join(root, 'plans', 'escape.md'), FILE);
	// run from a folder below the root, as a person might
	const nightjar = (args: string[], extra: Record<string, string> = {}) =>
		spawnSync(TSX, [CLI, ...args], {
			cwd: join(root, 'plans'),
			env: { ...env, ...extra },
			encoding: 'utf8',
			timeout: 25_000
		});
	const calls = () =>
		existsSync(env.FAKE_GH_CALLS ?? '') ? readFileSync(env.FAKE_GH_CALLS ?? '', 'utf8') : '';
	return { root, nightjar, calls };
}

describe('nightjar create', () => {
	it('makes the Feature and its Tickets on the Tracker, Tickets ready and linked, the Feature with no Signal', () => {
		const { nightjar, calls } = world();
		const run = nightjar(['create', 'escape.md']);
		expect(run.stderr).toBe('');
		expect(run.stdout).toBe(
			[
				'nightjar: made the Feature #1 Share one HTML escape',
				'nightjar: made Ticket 1 as #2 Move the escape into one module, ready',
				'nightjar: made Ticket 2 as #3 Use it in the comment renderer, blocked by #2, ready',
				'nightjar: #1 carries no Signal: assign it to yourself and give it the Go (factory-go) to build it.',
				''
			].join('\n')
		);
		expect(run.status).toBe(0);
		const log = calls();
		expect(log).toContain(
			'api -X POST repos/o/r/issues -f title=Share one HTML escape -f body=Two renderers escape HTML their own way.'
		);
		expect(log).toContain('api -X POST repos/o/r/issues/1/sub_issues -F sub_issue_id=1002');
		expect(log).toContain('api -X POST repos/o/r/issues/1/sub_issues -F sub_issue_id=1003');
		expect(log).toContain(
			'api -X POST repos/o/r/issues/3/dependencies/blocked_by -F issue_id=1002'
		);
		expect(log).toContain('api -X POST repos/o/r/issues/2/labels -f labels[]=ready-for-agent');
		expect(log).toContain('api -X POST repos/o/r/issues/3/labels -f labels[]=ready-for-agent');
		expect(log).not.toContain('repos/o/r/issues/1/labels');
	}, 30_000);

	it('with --dry-run, says what it would make and makes nothing', () => {
		const { nightjar, calls } = world();
		const run = nightjar(['create', '--dry-run', 'escape.md']);
		expect(run.stdout).toBe(
			[
				'nightjar: would make the Feature Share one HTML escape',
				'nightjar: would make Ticket 1 Move the escape into one module, on opus, ready',
				'nightjar: would make Ticket 2 Use it in the comment renderer, blocked by Ticket 1, ready',
				''
			].join('\n')
		);
		expect(run.status).toBe(0);
		expect(calls()).toBe('');
	}, 30_000);

	it('refuses a file out of the contract, naming each fault, and makes nothing', () => {
		const { root, nightjar, calls } = world();
		writeFileSync(
			join(root, 'plans', 'bad.md'),
			FILE.replace('**Blocked by:** 1', '**Blocked by:** 2')
		);
		const run = nightjar(['create', 'bad.md']);
		expect(run.stderr).toContain('nightjar: bad.md: line 13: Ticket 2 is blocked by "2"');
		expect(run.status).toBe(2);
		expect(calls()).toBe('');
	}, 30_000);

	it('refuses a Tracker that cannot make Features, before it makes anything', () => {
		const { nightjar, calls } = world({
			type: 'azure-devops',
			organization: 'contoso',
			project: 'Fabrikam',
			featureType: 'Feature'
		});
		const run = nightjar(['create', 'escape.md']);
		expect(run.stderr).toContain('nightjar: factory.json: tracker.ticketType: ');
		expect(run.status).toBe(2);
		expect(calls()).toBe('');
	}, 30_000);

	it('says what it made before a fault, and exits 1', () => {
		const { nightjar } = world();
		const run = nightjar(['create', 'escape.md'], { FAKE_GH_FAIL_AT: '3' });
		expect(run.stdout).toContain('nightjar: made Ticket 1 as #2');
		expect(run.stderr).toContain(
			'nightjar: gh could not open the issue Use it in the comment renderer: gh: Bad Gateway (HTTP 502); made before it: #1, #2. Nothing was undone.'
		);
		expect(run.status).toBe(1);
	}, 30_000);

	it('says how to call it when the file is missing', () => {
		const { nightjar } = world();
		const run = nightjar(['create']);
		expect(run.stderr).toContain('usage: nightjar create [--dry-run] FILE');
		expect(run.status).toBe(2);
		const gone = nightjar(['create', 'nope.md']);
		expect(gone.stderr).toContain('nightjar: cannot read nope.md');
		expect(gone.status).toBe(2);
	}, 30_000);
});
