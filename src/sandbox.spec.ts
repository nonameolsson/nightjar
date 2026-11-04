// Whether a machine can sandbox, over a machine of stand-ins for bwrap and socat.
import { afterEach, describe, expect, it } from 'vitest';
import { machine, type Machine } from './fakes/machine.js';
import { sandboxFinding, type Os } from './sandbox.js';

let m: Machine;
afterEach(() => m.remove());

const linux = (kernel: string): Os => ({ platform: 'linux', kernel });

describe('sandboxFinding', () => {
	it('finds Seatbelt on macOS, with nothing to install', async () => {
		m = machine(['bwrap', 'socat']);
		const found = await sandboxFinding({ platform: 'darwin', kernel: '' }, m.env, m.root);
		expect(found).toEqual({ name: 'Seatbelt', fault: null, caution: null });
	});

	it('refuses a platform other than macOS and Linux, by its name', async () => {
		m = machine();
		const found = await sandboxFinding({ platform: 'freebsd', kernel: '' }, m.env, m.root);
		expect(found.fault).toContain('cannot sandbox on freebsd');
		expect(found.fault).not.toContain('Windows');
	});

	it.each([
		['Linux', 'Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075)'],
		['WSL2', 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@1c602f52c2e4)'],
		['an early WSL2', 'Linux version 4.19.128-microsoft-standard (oe-user@oe-host)']
	])('finds bubblewrap and socat on %s', async (_, kernel) => {
		m = machine();
		const found = await sandboxFinding(linux(kernel), m.env, m.root);
		expect(found.name).toBe('bubblewrap and socat');
		expect(found.fault).toBeNull();
		expect(found.caution).toContain('may not reach it');
	});

	it('refuses WSL1, whose kernel says Microsoft with a capital M', async () => {
		m = machine();
		const found = await sandboxFinding(
			linux('Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)'),
			m.env,
			m.root
		);
		expect(found.fault).toContain('cannot sandbox on WSL1');
	});

	it('refuses a bwrap that cannot start a sandbox, and says how to let it', async () => {
		m = machine();
		const found = await sandboxFinding(linux(''), { ...m.env, FAKE_BWRAP_BLOCKED: '1' }, m.root);
		expect(found.fault).toContain('bubblewrap cannot start a sandbox');
		expect(found.fault).toContain('setting up uid map: Permission denied');
		expect(found.fault).toContain('AppArmor');
	});

	it('names the package of each tool that is missing', async () => {
		m = machine(['bwrap']);
		const found = await sandboxFinding(linux(''), m.env, m.root);
		expect(found.fault).toMatch(/^bubblewrap is not installed/);
	});
});
