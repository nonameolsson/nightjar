// `nightjar intake`: signed webhooks in, Features on the Tracker out, and every answer the spec lists.
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import {
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTAKE_HOST, INTAKE_PORT, parseIntakeArgs, USAGE } from './args.js';
import { FakeTracker } from './fakes/tracker.js';
import {
	AGAIN_MARKER,
	BODY_LIMIT,
	FAILED_SIGNATURES,
	startIntake,
	type IntakeServer,
	type ScheduledSource,
	type ServedSource
} from './intake.js';
import { parseCron } from './cron.js';
import { runNightjar } from './main.js';
import type { SourcedFeature } from './tracker.js';

const SECRET = `whsec_${Buffer.from('the secret of this spec').toString('base64')}`;

const TEMPLATE = `# Alert: {{ data.title }}

An alert came in.

## Ticket 1: Look into it

Find the cause and fix it.

### Acceptance criteria

- [ ] the cause is fixed
`;

let dir: string;
let clock: Date;
let tracker: FakeTracker;
let server: IntakeServer | null;
let said: string[];

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), 'nightjar-intake-')));
	// local noon, so a day later is another day on any clock
	clock = new Date(2026, 10, 3, 12, 0);
	tracker = new FakeTracker('ann', () => clock);
	server = null;
	said = [];
});
afterEach(async () => {
	await server?.close();
	rmSync(dir, { recursive: true, force: true });
});

const logPath = () => join(dir, '.factory', 'intake.log');

async function start(over: Partial<ServedSource> = {}, keyless = false): Promise<IntakeServer> {
	const source: ServedSource = {
		template: TEMPLATE,
		secret: SECRET,
		maxPerDay: 3,
		...(keyless ? {} : { key: 'data.id' }),
		...over
	};
	server = await startIntake({
		tracker,
		sources: new Map([['alerts', source]]),
		host: '127.0.0.1',
		port: 0,
		log: logPath(),
		now: () => clock,
		say: (line) => said.push(line)
	});
	return server;
}

// The Standard Webhooks headers of a delivery, signed with `secret` at `at`.
function signed(
	body: string,
	o: { id?: string; at?: Date; secret?: string } = {}
): Record<string, string> {
	const id = o.id ?? 'msg_1';
	const timestamp = String(Math.floor((o.at ?? clock).getTime() / 1000));
	const key = Buffer.from((o.secret ?? SECRET).replace(/^whsec_/, ''), 'base64');
	const hmac = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`);
	const signature = hmac.digest('base64');
	return {
		'content-type': 'application/json',
		'webhook-id': id,
		'webhook-timestamp': timestamp,
		'webhook-signature': `v1,${signature}`
	};
}

const event = (id: string, title = 'Disk full') => JSON.stringify({ data: { id, title } });

async function post(
	body: string,
	headers: Record<string, string> = signed(body),
	path = '/sources/alerts'
): Promise<{ status: number; json: unknown }> {
	if (server === null) throw new Error('intake is not started');
	const res = await fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
		method: 'POST',
		headers,
		body
	});
	const text = await res.text();
	return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
}

const features = () => [...tracker.items.values()].filter((i) => i.children.length > 0);

const later = (minutes: number) => {
	clock = new Date(clock.getTime() + minutes * 60 * 1000);
};

const logLines = () => {
	const text = readFileSync(logPath(), 'utf8').trim();
	return text.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe('intake', () => {
	it('makes one Feature with no Signal from a correctly signed delivery, and answers 201', async () => {
		await start();
		const { status, json } = await post(event('k-1'));
		expect(status).toBe(201);
		const [made, ...more] = features();
		expect(more).toEqual([]);
		expect(json).toEqual({ outcome: 'made', feature: made?.id });
		expect(made?.title).toBe('Alert: Disk full');
		expect(made?.signals).toEqual([]);
		expect(made?.assignees).toEqual([]);
		expect(made?.body).toContain('**Source:** alerts');
		expect(made?.body).toContain('<!-- nightjar:source=alerts key=k-1 -->');
	});

	it('makes nothing while a Feature with the same key is open, and comments at most once a day', async () => {
		await start();
		expect((await post(event('k-1'))).status).toBe(201);
		const [made] = features();
		const id = made?.id ?? '';
		later(1);
		expect(await post(event('k-1'), signed(event('k-1'), { id: 'msg_2' }))).toEqual({
			status: 200,
			json: { outcome: 'again', feature: id }
		});
		later(1);
		expect((await post(event('k-1'), signed(event('k-1'), { id: 'msg_3' }))).status).toBe(200);
		expect(features()).toHaveLength(1);
		expect(tracker.said(id)).toHaveLength(1);
		expect(tracker.said(id)[0]).toMatch(/^Happened again, 1 time since 2026-11-03 \d\d:\d\d\./);
		expect(tracker.said(id)[0]).toContain(AGAIN_MARKER);
		// the next day it says again how many came since its last comment
		later(24 * 60);
		expect((await post(event('k-1'), signed(event('k-1'), { id: 'msg_4' }))).status).toBe(200);
		expect(tracker.said(id)).toHaveLength(2);
		expect(tracker.said(id)[1]).toMatch(/^Happened again, 2 times since 2026-11-03 12:01\./);
		// another key is another Feature, and a closed one is no longer the same
		expect((await post(event('k-2'), signed(event('k-2'), { id: 'msg_5' }))).status).toBe(201);
		tracker.close(id);
		expect((await post(event('k-1'), signed(event('k-1'), { id: 'msg_6' }))).status).toBe(201);
		expect(features()).toHaveLength(3);
	});

	it('takes every delivery as new for a Source with no key', async () => {
		await start({}, true);
		expect((await post(event('k-1'))).status).toBe(201);
		expect((await post(event('k-1'))).status).toBe(201);
		expect(features()).toHaveLength(2);
	});

	it('answers 401 to a bad signature, or a timestamp 6 minutes off, and makes nothing', async () => {
		await start();
		const body = event('k-1');
		const old = new Date(clock.getTime() - 6 * 60 * 1000);
		const ahead = new Date(clock.getTime() + 6 * 60 * 1000);
		for (const headers of [
			signed(body, { secret: `whsec_${Buffer.from('another secret').toString('base64')}` }),
			signed(body, { at: old }),
			signed(body, { at: ahead }),
			{ ...signed(body), 'webhook-id': 'msg_other' },
			{ ...signed(body), 'webhook-signature': 'v1,' },
			{ 'content-type': 'application/json' }
		]) {
			expect((await post(body, headers)).status).toBe(401);
		}
		// a body changed after it was signed
		expect((await post(event('k-2'), signed(body))).status).toBe(401);
		expect(features()).toEqual([]);
		// within 5 minutes is in time
		const recent = new Date(clock.getTime() - 4 * 60 * 1000);
		expect((await post(body, signed(body, { at: recent }))).status).toBe(201);
	});

	it('makes nothing on the fourth delivery of a day with maxPerDay 3, and answers 200', async () => {
		await start({ maxPerDay: 3 });
		for (const key of ['a', 'b', 'c']) expect((await post(event(key))).status).toBe(201);
		expect(await post(event('d'))).toEqual({ status: 200, json: { outcome: 'day limit' } });
		expect(features()).toHaveLength(3);
		later(24 * 60);
		expect((await post(event('d'))).status).toBe(201);
	});

	it('counts the day from the Tracker, so Features another intake made count too', async () => {
		tracker.add({
			id: '90',
			title: 'Made elsewhere',
			body: '<!-- nightjar:source=alerts key=x -->',
			children: ['91'],
			at: clock.toISOString()
		});
		tracker.add({ id: '91', title: 'Its Ticket' });
		await start({ maxPerDay: 1 });
		expect((await post(event('k-1'))).status).toBe(200);
	});

	it('answers 503 when the Tracker fails, and the retry makes the Feature once', async () => {
		const finds = tracker.featuresFrom;
		let down = true;
		tracker.featuresFrom = (source: string): Promise<SourcedFeature[]> =>
			down ? Promise.reject(new Error('HTTP 502')) : finds(source);
		await start();
		expect(await post(event('k-1'))).toEqual({
			status: 503,
			json: { outcome: 'tracker failed' }
		});
		expect(features()).toEqual([]);
		expect(said.join('\n')).toContain('HTTP 502');
		down = false;
		expect((await post(event('k-1'))).status).toBe(201);
		expect((await post(event('k-1'))).status).toBe(200);
		expect(features()).toHaveLength(1);
	});

	it('answers 413 to a body over 256 KB', async () => {
		await start();
		const body = JSON.stringify({ data: { id: 'k-1', pad: 'x'.repeat(BODY_LIMIT) } });
		expect((await post(body)).status).toBe(413);
		expect(features()).toEqual([]);
	});

	it('answers 429 to everything after 20 failed signatures in a minute, until the minute is over', async () => {
		await start();
		const body = event('k-1');
		const wrong = {
			...signed(body),
			'webhook-signature': `v1,${Buffer.alloc(32).toString('base64')}`
		};
		for (let i = 0; i < FAILED_SIGNATURES; i += 1) {
			expect((await post(body, wrong)).status).toBe(401);
		}
		expect((await post(body, wrong)).status).toBe(429);
		expect((await post(body, wrong)).status).toBe(429);
		expect((await post(body)).status).toBe(429);
		expect(features()).toEqual([]);
		later(1);
		expect((await post(body)).status).toBe(201);
	});

	it('logs each delivery with its Source, id, answer and Feature, and nothing of the payload', async () => {
		await start();
		const body = JSON.stringify({ data: { id: 'key-in-payload', title: 'Title in payload' } });
		await post(body, signed(body, { id: 'msg_a' }));
		await post(body, signed(body, { id: 'msg_b' }));
		await post(body, { ...signed(body, { id: 'msg_c' }), 'webhook-signature': 'v1,AAAA' });
		const [made] = features();
		expect(logLines()).toEqual([
			{
				at: clock.toISOString(),
				source: 'alerts',
				delivery: 'msg_a',
				answer: 201,
				outcome: 'made',
				feature: made?.id
			},
			{
				at: clock.toISOString(),
				source: 'alerts',
				delivery: 'msg_b',
				answer: 200,
				outcome: 'again',
				feature: made?.id,
				commented: true
			},
			{
				at: clock.toISOString(),
				source: 'alerts',
				delivery: 'msg_c',
				answer: 401,
				outcome: 'bad signature'
			}
		]);
		const log = readFileSync(logPath(), 'utf8');
		expect(log).not.toContain('payload');
		expect(said.join('\n')).not.toContain('payload');
	});

	it('serves only its Sources, and takes only POST', async () => {
		await start();
		expect((await post(event('k-1'), signed(event('k-1')), '/sources/other')).status).toBe(404);
		expect((await post(event('k-1'), signed(event('k-1')), '/')).status).toBe(404);
		const res = await fetch(`http://127.0.0.1:${String(server?.port ?? 0)}/sources/alerts`);
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toBe('POST');
		expect(features()).toEqual([]);
	});

	it('answers 400 to a signed body that is not JSON', async () => {
		await start();
		expect((await post('not json')).status).toBe(400);
		expect(features()).toEqual([]);
	});
});

const WEEKLY_TEMPLATE = `# Update the dependencies, {{ date }}

The weekly update, made by {{ source }}.

## Ticket 1: Update them

Update each dependency.

### Acceptance criteria

- [ ] each dependency is current
`;

describe('intake over a schedule', () => {
	// the clock starts on Tuesday 3 November at noon, so the next Monday 06:00 is the 9th
	const MONDAY = new Date(2026, 10, 9, 6, 0);

	async function startSchedule(
		cron = '0 6 * * 1',
		over: Partial<ScheduledSource> = {},
		tickMs = 0
	): Promise<IntakeServer> {
		server = await startIntake({
			tracker,
			sources: new Map(),
			schedules: new Map([
				['weekly', { template: WEEKLY_TEMPLATE, cron: parseCron(cron), maxPerDay: 3, ...over }]
			]),
			host: '127.0.0.1',
			port: 0,
			log: logPath(),
			now: () => clock,
			say: (line) => said.push(line),
			tickMs
		});
		return server;
	}

	const tick = () => server?.tick() ?? Promise.resolve();

	it('makes nothing before it falls due', async () => {
		await startSchedule();
		await tick();
		clock = new Date(2026, 10, 9, 5, 59);
		await tick();
		expect(features()).toEqual([]);
	});

	it('makes one Feature with the date in its title when it falls due', async () => {
		await startSchedule();
		clock = MONDAY;
		await tick();
		const [made, ...more] = features();
		expect(more).toEqual([]);
		expect(made?.title).toBe('Update the dependencies, 2026-11-09');
		expect(made?.body).toContain('made by weekly.');
		expect(made?.body).toContain('**Source:** weekly');
		// the key is the Source's name, and a schedule has no payload to show
		expect(made?.body).toContain('<!-- nightjar:source=weekly key=weekly -->');
		expect(made?.body).not.toContain('Event payload');
		// no Signal and no assignee: the Go stays with a person
		expect(made?.signals).toEqual([]);
		expect(made?.assignees).toEqual([]);
		expect(logLines().at(-1)).toMatchObject({
			source: 'weekly',
			delivery: `schedule-${MONDAY.toISOString()}`,
			answer: 201,
			outcome: 'made',
			feature: made?.id
		});
	});

	it('makes one Feature at one due time, however often the clock is read', async () => {
		await startSchedule();
		clock = MONDAY;
		await tick();
		await tick();
		later(1);
		await tick();
		expect(features()).toHaveLength(1);
	});

	it('makes nothing while its last Feature is open, and no comment either', async () => {
		await startSchedule();
		clock = MONDAY;
		await tick();
		const [made] = features();
		clock = new Date(2026, 10, 16, 6, 0);
		await tick();
		expect(features()).toHaveLength(1);
		expect(tracker.said(made?.id ?? '')).toEqual([]);
		expect(logLines().at(-1)).toMatchObject({ outcome: 'still open', feature: made?.id });
		// once a person has closed it, the next due time makes another
		tracker.close(made?.id ?? '');
		clock = new Date(2026, 10, 23, 6, 0);
		await tick();
		expect(features()).toHaveLength(2);
		expect(features()[1]?.title).toBe('Update the dependencies, 2026-11-23');
	});

	it('makes one Feature for three missed weekly times, not three', async () => {
		await startSchedule();
		// the machine slept through the 9th, the 16th and the 23rd
		clock = new Date(2026, 10, 24, 8, 0);
		await tick();
		expect(features()).toHaveLength(1);
		// the next time counts from now: the 30th, not one of the missed ones
		tracker.close(features()[0]?.id ?? '');
		await tick();
		expect(features()).toHaveLength(1);
		clock = new Date(2026, 10, 30, 6, 0);
		await tick();
		expect(features()).toHaveLength(2);
	});

	it('does not make up a time that passed while intake was down', async () => {
		// intake starts on the 10th, after the 9th at 06:00 has come and gone
		clock = new Date(2026, 10, 10, 9, 0);
		await startSchedule();
		await tick();
		expect(features()).toEqual([]);
		clock = new Date(2026, 10, 16, 6, 0);
		await tick();
		expect(features()).toHaveLength(1);
		expect(features()[0]?.title).toBe('Update the dependencies, 2026-11-16');
	});

	it('counts what it makes against maxPerDay from the Tracker', async () => {
		await startSchedule('* * * * *', { maxPerDay: 1 });
		later(1);
		await tick();
		expect(features()).toHaveLength(1);
		tracker.close(features()[0]?.id ?? '');
		later(1);
		await tick();
		expect(features()).toHaveLength(1);
		expect(logLines().at(-1)).toMatchObject({ outcome: 'day limit' });
	});

	it('says when the Tracker fails, and tries again at the next due time', async () => {
		const finds = tracker.featuresFrom;
		let down = true;
		tracker.featuresFrom = (source: string): Promise<SourcedFeature[]> =>
			down ? Promise.reject(new Error('HTTP 502')) : finds(source);
		await startSchedule();
		clock = MONDAY;
		await tick();
		expect(said.join('\n')).toContain('HTTP 502');
		expect(features()).toEqual([]);
		expect(logLines().at(-1)).toMatchObject({ answer: 503, outcome: 'tracker failed' });
		down = false;
		clock = new Date(2026, 10, 16, 6, 0);
		await tick();
		expect(features()).toHaveLength(1);
	});

	it('fires by its own timer as the clock reaches the due time', async () => {
		await startSchedule('0 6 * * 1', {}, 5);
		clock = MONDAY;
		await vi.waitFor(() => expect(features()).toHaveLength(1));
	});

	it('shares a webhook Source server with schedules', async () => {
		server = await startIntake({
			tracker,
			sources: new Map([['alerts', { template: TEMPLATE, secret: SECRET, maxPerDay: 3 }]]),
			schedules: new Map([
				['weekly', { template: WEEKLY_TEMPLATE, cron: parseCron('0 6 * * 1'), maxPerDay: 3 }]
			]),
			host: '127.0.0.1',
			port: 0,
			log: logPath(),
			now: () => clock,
			say: (line) => said.push(line),
			tickMs: 0
		});
		expect((await post(event('k-1'))).status).toBe(201);
		clock = MONDAY;
		await tick();
		expect(features().map((f) => f.title)).toEqual([
			'Alert: Disk full',
			'Update the dependencies, 2026-11-09'
		]);
	});
});

describe('nightjar intake arguments', () => {
	it('listens on 127.0.0.1:4546 unless --host or --port says otherwise', () => {
		expect(parseIntakeArgs([])).toEqual({ host: INTAKE_HOST, port: INTAKE_PORT });
		expect(INTAKE_HOST).toBe('127.0.0.1');
		expect(parseIntakeArgs(['--host', '0.0.0.0', '--port', '8080'])).toEqual({
			host: '0.0.0.0',
			port: 8080
		});
		for (const argv of [['--port'], ['--port', 'x'], ['--port', '70000'], ['--host'], ['5']]) {
			expect(typeof parseIntakeArgs(argv)).toBe('string');
		}
	});

	it('is listed by nightjar help', () => {
		expect(USAGE).toMatch(/nightjar intake \[--port PORT\] \[--host HOST\]/);
	});
});

// The command over a repo whose Tracker and Code host are modules, so no network is reached.
describe('nightjar intake', () => {
	let out: string[];
	let err: string[];
	beforeEach(() => {
		spawnSync('git', ['init', '-q'], { cwd: dir });
		out = [];
		err = [];
		vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
		vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
	});
	afterEach(() => vi.restoreAllMocks());

	const TRACKER = (more: string) => `export const createTracker = () => ({
	me: async () => 'zed',
	assignedFeatures: async () => [],
	feature: async () => ({ id: '1', title: 't', body: '' }),
	standing: async () => ({ assignees: [], signals: [] }),
	tickets: async () => [],
	comments: async () => [],
	addSignal: async () => {},
	removeSignal: async () => {},
	comment: async () => {},
	reference: (id) => ({ id, text: '#' + id }),
	${more}
});`;
	const WRITES = 'createFeature: async () => "7", createTicket: async () => "8", block() {},';
	const FINDS = 'featuresFrom: async () => [],';
	const ALERTS = {
		alerts: {
			type: 'webhook',
			template: '.nightjar/alerts.md',
			key: 'data.id',
			secretEnv: 'ALERTS_SECRET'
		}
	};

	function repo(more: string, sources: unknown = ALERTS) {
		writeFileSync(join(dir, 'tracker.mjs'), TRACKER(more));
		writeFileSync(
			join(dir, 'host.mjs'),
			`export const createCodeHost = () => ({ push: async () => {}, openPull: async () => null, createDraft: async () => ({ id: 1, url: 'u' }), editBody: async () => {}, placeReferences: async () => {}, comment: async () => {} });`
		);
		mkdirSync(join(dir, '.nightjar'));
		writeFileSync(join(dir, '.nightjar', 'alerts.md'), TEMPLATE);
		writeFileSync(
			join(dir, 'factory.json'),
			JSON.stringify({
				tracker: { type: 'module', path: './tracker.mjs' },
				codeHost: { type: 'module', path: './host.mjs' },
				check: 'make check',
				allowedCommands: [],
				sources
			})
		);
	}

	const host = (stop?: AbortSignal) => ({
		platform: 'linux' as const,
		env: { PATH: process.env.PATH, ALERTS_SECRET: SECRET },
		cwd: dir,
		...(stop === undefined ? {} : { stop })
	});

	it('binds 127.0.0.1 by default, serves each webhook Source at /sources/NAME, and logs to .factory/intake.log', async () => {
		repo(`${WRITES} ${FINDS}`);
		const stop = new AbortController();
		const done = runNightjar(['intake', '--port', '0'], host(stop.signal));
		await vi.waitFor(() => expect(out.join('\n')).toContain('intake on http://127.0.0.1:'));
		const port = Number(/127\.0\.0\.1:(\d+)/.exec(out.join('\n'))?.[1]);
		expect(out.join('\n')).toContain(
			`Source alerts: POST http://127.0.0.1:${String(port)}/sources/alerts`
		);
		const body = event('k-1');
		const res = await fetch(`http://127.0.0.1:${String(port)}/sources/alerts`, {
			method: 'POST',
			headers: signed(body, { at: new Date() }),
			body
		});
		expect(res.status).toBe(201);
		expect(existsSync(join(dir, '.factory', 'intake.log'))).toBe(true);
		stop.abort();
		expect(await done).toBe(0);
	});

	it('refuses to start on a Tracker without featuresFrom, naming it', async () => {
		repo(WRITES);
		expect(await runNightjar(['intake', '--port', '0'], host())).toBe(2);
		expect(err.join('\n')).toContain('featuresFrom');
		expect(err.join('\n')).not.toContain('createFeature');
	});

	it('refuses to start on a Tracker that makes no Features, naming the methods', async () => {
		repo(FINDS);
		expect(await runNightjar(['intake', '--port', '0'], host())).toBe(2);
		expect(err.join('\n')).toContain('createFeature, createTicket and block');
		expect(err.join('\n')).not.toContain('featuresFrom');
	});

	it('refuses to start while a webhook Source has no secret', async () => {
		repo(`${WRITES} ${FINDS}`);
		const bare = { ...host(), env: { PATH: process.env.PATH } };
		expect(await runNightjar(['intake', '--port', '0'], bare)).toBe(2);
		expect(err.join('\n')).toContain('Source alerts: ALERTS_SECRET is not set');
	});

	it('runs a schedule Source with no webhook, and says when it is next due', async () => {
		repo(`${WRITES} ${FINDS}`, {
			weekly: { type: 'schedule', cron: '0 6 * * 1', template: '.nightjar/alerts.md' }
		});
		const stop = new AbortController();
		const bare = { ...host(stop.signal), env: { PATH: process.env.PATH } };
		const done = runNightjar(['intake', '--port', '0'], bare);
		await vi.waitFor(() => expect(out.join('\n')).toContain('Source weekly: next due '));
		expect(out.join('\n')).toMatch(/Source weekly: next due \d{4}-\d\d-\d\d 06:00/);
		expect(out.join('\n')).not.toContain('POST');
		stop.abort();
		expect(await done).toBe(0);
	});

	it('refuses to start while a schedule Source has a template that does not read', async () => {
		repo(`${WRITES} ${FINDS}`, {
			weekly: { type: 'schedule', cron: '@weekly', template: '.nightjar/gone.md' }
		});
		expect(await runNightjar(['intake', '--port', '0'], host())).toBe(2);
		expect(err.join('\n')).toContain('Source weekly: template .nightjar/gone.md');
	});

	it('refuses to start while factory.json has a cron time that is out of range, naming the Source', async () => {
		repo(`${WRITES} ${FINDS}`, {
			weekly: { type: 'schedule', cron: '61 * * * *', template: '.nightjar/alerts.md' }
		});
		expect(await runNightjar(['intake', '--port', '0'], host())).toBe(2);
		expect(err.join('\n')).toContain('sources.weekly.cron: minute: 61 is not from 0 to 59');
	});

	it('refuses to start with no Source', async () => {
		repo(`${WRITES} ${FINDS}`, {});
		expect(await runNightjar(['intake', '--port', '0'], host())).toBe(2);
		expect(err.join('\n')).toContain('no sources');
	});
});
