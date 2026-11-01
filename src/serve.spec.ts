import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { claimPorts } from './ports.js';
import { startServe } from './serve.js';

const open = (port: number) =>
	new Promise<boolean>((done) => {
		const socket = connect({ port, host: '127.0.0.1' });
		socket.once('connect', () => {
			socket.destroy();
			done(true);
		});
		socket.once('error', () => done(false));
	});

const LISTEN = `node -e "require('net').createServer().listen(Number(process.env.WEB_PORT),'127.0.0.1')"`;

describe('startServe', () => {
	it('waits for the port, hands the command its environment, and ends it on stop', async () => {
		const claim = await claimPorts({ count: 1 });
		if (claim === null) throw new Error('no free port');
		try {
			const served = await startServe(
				LISTEN,
				process.cwd(),
				{ ...process.env, WEB_PORT: String(claim.port) },
				claim.port
			);
			expect(served.ok).toBe(true);
			expect(await open(claim.port)).toBe(true);
			if (served.ok) await served.stop();
			expect(await open(claim.port)).toBe(false);
		} finally {
			claim.release();
		}
	}, 30_000);

	it('fails with what the command said when it exits before it listens', async () => {
		const served = await startServe('echo no config >&2; exit 3', process.cwd(), process.env, 4999);
		expect(served).toMatchObject({ ok: false });
		expect(!served.ok && served.tail).toContain('exited with code 3');
		expect(!served.ok && served.tail).toContain('no config');
	}, 30_000);

	it('starts a command that listens on no port, without waiting', async () => {
		const served = await startServe('sleep 30', process.cwd(), process.env, null);
		expect(served.ok).toBe(true);
		if (served.ok) await served.stop();
	}, 30_000);
});
