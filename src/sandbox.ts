// Whether this machine can sandbox: every Session runs in Claude Code's sandbox and fails closed (see SANDBOX in settings.ts),
// so a machine that cannot gets no build.
import { readFileSync } from 'node:fs';
import { run, type Env } from './git.js';

export interface SandboxFinding {
	// why a sandboxed Step cannot run here, with the fix; null when it can
	readonly fault: string | null;
	// what the person should know even where it can run; null when nothing
	readonly caution: string | null;
}

const NO_SERVE =
	'on Linux and WSL2 a sandboxed command has its own loopback, so a direct connection to serve at $APP_PORT may not reach it; only HTTP clients that honour the sandbox proxy variables may (see "localNetwork" in the README)';

// The text of /proc/version, which says WSL1 ("Microsoft") from WSL2 ("microsoft-standard-WSL2"); '' where there is none.
export function readKernel(): string {
	try {
		return readFileSync('/proc/version', 'utf8');
	} catch {
		return '';
	}
}

export async function sandboxFinding(
	platform: NodeJS.Platform,
	env: Env,
	kernel: string,
	cwd: string
): Promise<SandboxFinding> {
	if (platform === 'darwin') return { fault: null, caution: null };
	if (platform !== 'linux') {
		return {
			fault: 'Claude Code cannot sandbox on native Windows; run Nightjar on macOS, Linux or WSL2.',
			caution: null
		};
	}
	if (/microsoft/i.test(kernel) && !/wsl2/i.test(kernel)) {
		return {
			fault:
				'Claude Code cannot sandbox on WSL1; move the distribution to WSL2 (`wsl --set-version <distro> 2` in Windows), then run again.',
			caution: null
		};
	}
	const missing: string[] = [];
	for (const tool of ['bwrap', 'socat']) {
		if ((await run(tool, ['-V'], cwd, env)).missing) {
			missing.push(tool === 'bwrap' ? 'bubblewrap' : tool);
		}
	}
	if (missing.length > 0) {
		return {
			fault: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not installed, and without them Claude Code cannot sandbox. Install them with \`sudo apt-get install bubblewrap socat\` (Debian, Ubuntu, WSL2) or \`sudo dnf install bubblewrap socat\` (Fedora), then run \`nightjar doctor\` again.`,
			caution: null
		};
	}
	return { fault: null, caution: NO_SERVE };
}
