// `nightjar ui`: the argument, the repo root, the Tracker the page reads, and keeping the page up until it is told to stop.
import type { AzureDevOpsRequest } from './azure-devops/index.js';
import type { GhRunner } from './github/api.js';
import { run, type Env } from './git.js';
import { say, why } from './say.js';
import { startUi, UI_PORT } from './ui.js';
import { detailFrom, listsFrom, openOnce, openPageTracker } from './ui-tracker.js';

export const UI_USAGE = 'usage: nightjar ui [--port PORT]';

export interface UiHost {
	readonly cwd: string;
	readonly env: Env;
	// ends the page; Ctrl-C or SIGTERM unless a spec passes its own
	readonly stop?: AbortSignal;
	// answers every Azure DevOps call; a spec passes a fake Azure DevOps
	readonly request?: AzureDevOpsRequest;
	// runs every `gh` call; a spec passes a fake GitHub
	readonly gh?: GhRunner;
}

// The port, or the line that says what is wrong with the arguments. There is no flag for the address: the page is on 127.0.0.1 only.
function parsePort(argv: readonly string[]): number | string {
	if (argv.length === 0) return UI_PORT;
	const [flag, value, ...rest] = argv;
	if (flag !== '--port' || value === undefined || rest.length > 0)
		return `unknown argument ${argv.find((a) => a !== '--port') ?? flag ?? ''}`;
	const port = /^\d+$/.test(value) ? Number(value) : NaN;
	return port <= 65535 ? port : `--port needs a number from 0 to 65535, not ${value}`;
}

function onSignals(): AbortSignal {
	const stop = new AbortController();
	process.once('SIGINT', () => stop.abort());
	process.once('SIGTERM', () => stop.abort());
	return stop.signal;
}

export async function runUiCommand(argv: readonly string[], host: UiHost): Promise<number> {
	const port = parsePort(argv);
	if (typeof port === 'string') {
		console.error(`nightjar: ${port}\n\n${UI_USAGE}`);
		return 2;
	}
	const top = await run('git', ['rev-parse', '--show-toplevel'], host.cwd, host.env);
	if (!top.ok) {
		console.error('nightjar: not inside a git checkout; run ui in the repo.');
		return 2;
	}
	const root = top.out.trim();
	const env: Env = { ...host.env, GIT_TERMINAL_PROMPT: '0' };
	const seams = {
		...(host.request === undefined ? {} : { request: host.request }),
		...(host.gh === undefined ? {} : { gh: host.gh })
	};
	// one Tracker for the lists and the Feature detail panel, opened on the first read
	const page = openOnce(() => openPageTracker(root, env, seams));
	try {
		const ui = await startUi({
			root,
			port,
			// read-only: the page never writes to the Tracker (docs/adr/0009)
			tracker: listsFrom(page),
			feature: detailFrom(page),
			// the Measures ask it whether pull requests merged, an hour apart at the most
			codeHost: async () => (await page()).codeHost
		});
		say(`http://127.0.0.1:${String(ui.port)}  (Ctrl-C to stop)`);
		const stop = host.stop ?? onSignals();
		await new Promise<void>((done) => {
			if (stop.aborted) done();
			stop.addEventListener('abort', () => done(), { once: true });
		});
		await ui.close();
		return 0;
	} catch (fault) {
		if ((fault as NodeJS.ErrnoException).code === 'EADDRINUSE') {
			console.error(
				`nightjar: port ${String(port)} is taken; stop what uses it or pick another with --port.`
			);
		} else console.error(`nightjar: ${why(fault)}`);
		return 2;
	}
}
