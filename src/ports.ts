// Tests listen on a run's ports only while they run, so a free port is not enough: each port has a lock file holding the owner's pid.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// clear of the ports dev servers and test runners commonly default to
export const FIRST_PORT = 4477;
export const LAST_PORT = 5476;

export const defaultLocks = () => join(tmpdir(), 'nightjar-ports');

// The lock files this process holds right now, one claim per piece of work in a Slot: the pid in a lock cannot tell two of them apart.
const heldHere = new Set<string>();

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const holder = (file: string): number | null => {
	try {
		const pid = Number(readFileSync(file, 'utf8').trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
};

export function portFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const server = createServer();
		server.once('error', () => done(false));
		server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
	});
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PortClaim {
	// the first of `count` consecutive ports
	readonly port: number;
	release(): void;
}

export interface ClaimOptions {
	readonly count: number;
	readonly locks?: string;
	readonly pid?: number;
	readonly free?: (port: number) => Promise<boolean>;
}

// The environment variables that hand a run its ports: the first port to the first name, and so on.
export function portEnv(first: number, names: readonly string[]): Record<string, string> {
	return Object.fromEntries(names.map((name, i) => [name, String(first + i)]));
}

// A block of ports claimed for one piece of work in a Slot: the variables its Sessions and commands see, the ports said for a line, and the way to give the block back.
export interface PortLease {
	readonly env: Readonly<Record<string, string>>;
	readonly ports: string;
	release(): void;
}

// Claims a block for one piece of work, or null when none is free; `names` are the variables that carry the block's ports.
export async function leasePorts(
	options: ClaimOptions & { readonly names: readonly string[] }
): Promise<PortLease | null> {
	const claim = await claimPorts(options);
	if (claim === null) return null;
	return {
		env: portEnv(claim.port, options.names),
		ports: `${String(claim.port)} to ${String(claim.port + options.count - 1)}`,
		release: () => claim.release()
	};
}

// The first block of `count` ports that no live run holds and nothing listens on, or null.
export async function claimPorts(options: ClaimOptions): Promise<PortClaim | null> {
	const { count } = options;
	const locks = options.locks ?? defaultLocks();
	const pid = options.pid ?? process.pid;
	const free = options.free ?? portFree;
	mkdirSync(locks, { recursive: true });
	// one picker at a time (mkdir is atomic), so two runs never both read a block as free
	const picking = join(locks, '.picking');
	for (let waited = 0; ; waited += 1) {
		try {
			mkdirSync(picking);
			break;
		} catch {
			const held = holder(join(picking, 'pid'));
			if ((held !== null && !alive(held)) || (held === null && waited >= 50)) {
				rmSync(picking, { recursive: true, force: true });
				continue;
			}
			if (waited >= 1200) return null;
			await pause(100);
		}
	}
	writeFileSync(join(picking, 'pid'), String(pid));
	try {
		for (let first = FIRST_PORT; first + count - 1 <= LAST_PORT; first += count) {
			const ports = Array.from({ length: count }, (_, i) => first + i);
			// a lock per port, so blocks of different counts on one machine never overlap
			// a lock with this very pid is stale (a dead run's pid came round again) unless a claim of this process holds it, as a Slot's does
			const taken = ports.some((port) => {
				const lock = join(locks, String(port));
				if (heldHere.has(lock)) return true;
				const held = holder(lock);
				return held !== null && held !== pid && alive(held);
			});
			if (taken) continue;
			let all = true;
			for (const port of ports) {
				all = await free(port);
				if (!all) break;
			}
			if (!all) continue;
			for (const port of ports) {
				const lock = join(locks, String(port));
				writeFileSync(lock, String(pid));
				heldHere.add(lock);
			}
			let released = false;
			return {
				port: first,
				// removes a lock only while it is still this run's, and gives the block back once however often it is called
				release: () => {
					if (released) return;
					released = true;
					for (const port of ports) {
						const lock = join(locks, String(port));
						if (holder(lock) !== pid) continue;
						heldHere.delete(lock);
						rmSync(lock, { force: true });
					}
				}
			};
		}
		return null;
	} finally {
		rmSync(picking, { recursive: true, force: true });
	}
}
