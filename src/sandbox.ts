// Whether this machine can run Claude Code's sandbox, which every Session needs (see SANDBOX in settings.ts).
import { readFileSync } from 'node:fs';
import { firstLine, run, type Env } from './git.js';

// The operating system the command runs on; only the CLI entry reads the real one, a spec passes its own.
export interface Os {
	readonly platform: NodeJS.Platform;
	// the text of /proc/version, which tells WSL1 from WSL2; '' where there is none
	readonly kernel: string;
}

export function thisOs(): Os {
	let kernel = '';
	try {
		kernel = readFileSync('/proc/version', 'utf8');
	} catch {
		// no /proc/version: not Linux
	}
	return { platform: process.platform, kernel };
}

export interface SandboxFinding {
	// what sandboxes a Session here
	readonly name: string;
	// why no Session can run here, with the fix; null when one can
	readonly fault: string | null;
	// what the person should know even where it can run; null when nothing
	readonly caution: string | null;
}

const NO_SERVE =
	'on Linux and WSL2 a sandboxed command has its own loopback, so a direct connection to serve at $APP_PORT may not reach it; only HTTP clients that honour the sandbox proxy variables may (see "localNetwork" in the README)';

const BUBBLEWRAP = 'bubblewrap and socat';

// each command Claude Code's sandbox runs on Linux, by its package; bwrap is tried on a sandbox around `true`
const LINUX_TOOLS = [
	{ command: 'bwrap', pkg: 'bubblewrap', args: ['--ro-bind', '/', '/', '--unshare-all', 'true'] },
	{ command: 'socat', pkg: 'socat', args: ['-V'] }
];

export async function sandboxFinding(os: Os, env: Env, cwd: string): Promise<SandboxFinding> {
	if (os.platform === 'darwin') return { name: 'Seatbelt', fault: null, caution: null };
	// main.ts stops native Windows first, so this is another platform Claude Code has no sandbox for
	if (os.platform !== 'linux') {
		return {
			name: 'none',
			fault: `Claude Code cannot sandbox on ${os.platform}; run Nightjar on macOS, Linux or WSL2.`,
			caution: null
		};
	}
	// WSL1 says "Microsoft"; every WSL2 says "microsoft-standard", lower case
	if (/Microsoft/.test(os.kernel)) {
		return {
			name: BUBBLEWRAP,
			fault:
				'Claude Code cannot sandbox on WSL1; move the distribution to WSL2 (`wsl --set-version <distro> 2` in Windows), then run again.',
			caution: null
		};
	}
	const ran = await Promise.all(
		LINUX_TOOLS.map(async (tool) => ({
			...tool,
			...(await run(tool.command, tool.args, cwd, env))
		}))
	);
	const missing = ran.filter((tool) => tool.missing).map((tool) => tool.pkg);
	if (missing.length > 0) {
		return {
			name: BUBBLEWRAP,
			fault: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not installed, and without them Claude Code cannot sandbox. Install them with \`sudo apt-get install bubblewrap socat\` (Debian, Ubuntu, WSL2) or \`sudo dnf install bubblewrap socat\` (Fedora), then run \`nightjar doctor\` again.`,
			caution: null
		};
	}
	const bwrap = ran.find((tool) => tool.command === 'bwrap');
	if (bwrap !== undefined && !bwrap.ok) {
		return {
			name: BUBBLEWRAP,
			fault: `bubblewrap cannot start a sandbox here (${firstLine(bwrap.err) || 'it exited with an error'}), so neither can Claude Code. On Ubuntu 23.10 and later AppArmor keeps it from making a user namespace: give bwrap an AppArmor profile that allows \`userns\` (see https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces), then run \`nightjar doctor\` again.`,
			caution: null
		};
	}
	return { name: BUBBLEWRAP, fault: null, caution: NO_SERVE };
}
