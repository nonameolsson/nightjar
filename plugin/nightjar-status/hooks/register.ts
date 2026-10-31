import type { EngineInterface, Register } from 'claude-code';
import type { Status } from '../../../src/status-shape.js';
import { line, toast } from './format';

const EVERY_MS = 5_000;

// undefined until the first read, which takes the events already there without toasting them
let seen: number | undefined;

// .factory/ is in the main checkout, the folder that holds the git common dir, worktree or not
async function statusFile($: EngineInterface): Promise<string | undefined> {
	const git = await $.process.run([
		'git',
		'rev-parse',
		'--path-format=absolute',
		'--git-common-dir'
	]);
	if (git.exitCode !== 0) return undefined;
	return `${git.stdout.trim().replace(/\/\.git$/, '')}/.factory/status.json`;
}

async function tick($: EngineInterface, path: string): Promise<void> {
	if (!(await $.fs.exists(path))) return $.ui.status(undefined);
	let status: Status;
	try {
		status = JSON.parse(await $.fs.read(path)) as Status;
	} catch {
		// Nightjar renames its writes into place, so this is a file someone broke; wait for the next
		return;
	}
	if (seen !== undefined) {
		for (const e of status.recent) if (e.seq > seen) $.ui.toast(toast(e), { timeoutMs: 8_000 });
	}
	seen = status.recent.at(-1)?.seq ?? 0;
	const isOff = status.doing.kind === 'off';
	if (!isOff && (await $.process.run(['kill', '-0', String(status.pid)])).exitCode !== 0) {
		return $.ui.status('nightjar: stopped without writing off');
	}
	$.ui.status(line(status, await $.clock.now()));
}

export const register: Register = (on) => {
	on('session.start', async ($, e, next) => {
		const done = await next(e);
		const path = await statusFile($);
		if (path === undefined) return done;
		await tick($, path);
		$.clock.every(EVERY_MS, () => void tick($, path));
		return done;
	});
};
