// `nightjar intake`: takes the deliveries of factory.json's webhook and Sentry Sources and makes their Features on the Tracker; it never builds.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { makeAdapters, type Adapters, type Seams } from './adapters.js';
import { INTAKE_USAGE, parseIntakeArgs } from './args.js';
import { ConfigError, DEFAULT_MAX_PER_DAY, loadConfig, type Config } from './config.js';
import { makeFeature } from './create.js';
import { localTime, nextDue, parseCron, type Cron } from './cron.js';
import { FeatureFileError } from './feature-file.js';
import { run, type Env } from './git.js';
import { say as sayLine, why } from './say.js';
import { fillTemplate, lookup, readTemplate, templateFaults } from './template.js';
import type { FeatureWriter, ItemId, SourcedFeature, Tracker } from './tracker.js';

// the largest body a delivery may have
export const BODY_LIMIT = 256 * 1024;

// how far a delivery's timestamp may be from this machine's clock, either way
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

// failed signatures a Source takes in a minute before it answers 429 to everything
export const FAILED_SIGNATURES = 20;
const FAILED_WINDOW_MS = 60 * 1000;

// the hidden mark on the "happened again" comment, by which the next delivery finds when the last one was
export const AGAIN_MARKER = '<!-- nightjar:again -->';

export const intakeLogPath = (root: string) => join(root, '.factory', 'intake.log');

// A Tracker that makes Features and finds again those a Source made.
export type IntakeTracker = Tracker & FeatureWriter & Required<Pick<Tracker, 'featuresFrom'>>;

const findsSources = (tracker: Tracker & FeatureWriter): tracker is IntakeTracker =>
	typeof tracker.featuresFrom === 'function';

// where Sentry puts the id of the issue an alert is about; the key of a sentry Source that names none
export const SENTRY_KEY = 'data.event.issue_id';

// the one Sentry resource intake takes: an issue alert rule that fired
export const SENTRY_RESOURCE = 'event_alert';

// A webhook Source as intake serves it: its template read, its secret taken from the environment.
export interface ServedSource {
	// the template's text, a Feature file with placeholders
	readonly template: string;
	// the Standard Webhooks secret, `whsec_` and base64 as the sender gives it; for a sentry Source, the integration's client secret as it is
	readonly secret: string;
	// how a delivery is signed: by the Standard Webhooks scheme, or Sentry's own; webhook when left out
	readonly type?: 'webhook' | 'sentry';
	readonly key?: string;
	readonly maxPerDay: number;
	// for a `go: true` Source: whom each Feature is assigned to before it is given the Go; left out, the Go stays with a person
	readonly owner?: string;
}

// A schedule Source as intake fires it.
export interface ScheduledSource {
	readonly template: string;
	readonly cron: Cron;
	readonly maxPerDay: number;
	readonly owner?: string;
}

// how often intake looks at the clock for a schedule that has come due
export const TICK_MS = 1000;

export interface IntakeOptions {
	readonly tracker: IntakeTracker;
	readonly sources: ReadonlyMap<string, ServedSource>;
	// the schedules, which fire at their due times as the clock reaches them; none when left out
	readonly schedules?: ReadonlyMap<string, ScheduledSource>;
	// how often the clock is looked at; 0 leaves it to `tick`, as a spec does
	readonly tickMs?: number;
	readonly host: string;
	readonly port: number;
	// .factory/intake.log
	readonly log: string;
	readonly now?: () => Date;
	readonly say?: (line: string) => void;
}

export interface IntakeServer {
	readonly address: string;
	readonly port: number;
	// fires each schedule whose due time the clock has reached; resolves once their Features are made or refused
	readonly tick: () => Promise<void>;
	readonly close: () => Promise<void>;
}

type Outcome =
	| 'made'
	| 'made without the go'
	| 'again'
	| 'still open'
	| 'day limit'
	| 'other resource'
	| 'bad signature'
	| 'too many bad signatures'
	| 'too large'
	| 'not json'
	| 'template failed'
	| 'tracker failed'
	| 'not post';

interface Answer {
	readonly status: number;
	readonly outcome: Outcome;
	readonly feature?: ItemId;
	// whether intake commented "happened again" on the open Feature
	readonly commented?: boolean;
}

// One line of .factory/intake.log: never anything of the payload.
interface LogEntry {
	readonly at: string;
	readonly source: string;
	readonly delivery: string;
	readonly answer: number;
	readonly outcome: Outcome;
	readonly feature?: ItemId;
	readonly commented?: boolean;
}

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
	const value = headers[name];
	return typeof value === 'string' ? value : undefined;
};

// the sender's id of a delivery, kept to the characters an id has, so the log holds nothing else
const deliveryId = (headers: IncomingHttpHeaders): string =>
	(header(headers, 'webhook-id') ?? '').replace(/[^\w.:-]/g, '').slice(0, 100);

// Standard Webhooks gives the secret as `whsec_` and the key in base64.
const secretKey = (secret: string): Buffer =>
	Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');

// Whether a delivery is signed with the secret by the Standard Webhooks scheme, and sent within 5 minutes of now.
export function signedRight(
	secret: string,
	headers: IncomingHttpHeaders,
	body: Buffer,
	now: Date
): boolean {
	const id = header(headers, 'webhook-id');
	const timestamp = header(headers, 'webhook-timestamp');
	const signatures = header(headers, 'webhook-signature');
	if (id === undefined || timestamp === undefined || signatures === undefined) return false;
	if (!/^\d{1,12}$/.test(timestamp)) return false;
	if (Math.abs(now.getTime() - Number(timestamp) * 1000) > TIMESTAMP_TOLERANCE_MS) return false;
	const expected = createHmac('sha256', secretKey(secret))
		.update(`${id}.${timestamp}.`)
		.update(body)
		.digest();
	// the header may carry several signatures, as while a secret is rotated
	return signatures.split(' ').some((signature) => {
		if (!signature.startsWith('v1,')) return false;
		const given = Buffer.from(signature.slice('v1,'.length), 'base64');
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}

// Whether a delivery carries the signature Sentry gives it: the hex HMAC SHA-256 of the raw body, with the integration's client secret.
export function sentrySignedRight(
	secret: string,
	headers: IncomingHttpHeaders,
	body: Buffer
): boolean {
	const signature = header(headers, 'sentry-hook-signature');
	if (signature === undefined || !/^[0-9a-f]+$/i.test(signature)) return false;
	const expected = createHmac('sha256', secret).update(body).digest();
	const given = Buffer.from(signature, 'hex');
	return given.length === expected.length && timingSafeEqual(given, expected);
}

const pad = (n: number) => String(n).padStart(2, '0');

// the day as the machine's calendar has it, as maxPerDay counts days
const day = (at: Date) =>
	`${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

// The deliveries of `source` that found `feature` open since `since`, by this machine's log, leaving out the one that commented.
function repeatsSince(log: string, source: string, feature: ItemId, since: string): number {
	let text: string;
	try {
		text = readFileSync(log, 'utf8');
	} catch {
		return 0;
	}
	let count = 0;
	for (const line of text.split('\n')) {
		let entry: Partial<LogEntry>;
		try {
			entry = JSON.parse(line) as Partial<LogEntry>;
		} catch {
			continue;
		}
		if (
			entry.source === source &&
			entry.feature === feature &&
			entry.outcome === 'again' &&
			entry.commented !== true &&
			typeof entry.at === 'string' &&
			Date.parse(entry.at) >= Date.parse(since)
		)
			count += 1;
	}
	return count;
}

// The body, or null once it is over the limit.
function readBody(req: IncomingMessage): Promise<Buffer | null> {
	return new Promise((done, fail) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let over = false;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > BODY_LIMIT) over = true;
			if (!over) chunks.push(chunk);
		});
		req.on('end', () => done(over ? null : Buffer.concat(chunks)));
		req.on('error', fail);
	});
}

// Why a `go: true` Source cannot give the Go for `owner` on this Tracker, or null when it can: the Tracker must assign, and must trust the owner by factory.json's `trusted` list, else by its own default.
export async function goFault(
	tracker: Tracker,
	owner: string,
	trusted: readonly string[] | undefined
): Promise<string | null> {
	if (typeof tracker.assign !== 'function') {
		return `go: true assigns each Feature to its owner through assign, which this Tracker lacks (docs/custom-adapters.md)`;
	}
	let trusts: boolean;
	if (trusted !== undefined) {
		trusts = trusted.some((t) => t.toLowerCase() === owner.toLowerCase());
	} else if (typeof tracker.trusts !== 'function') {
		return `go: true needs a trusted owner, and this Tracker cannot say whether ${owner} is, as it lacks trusts: name ${owner} in factory.json's trusted list`;
	} else {
		try {
			trusts = await tracker.trusts(owner);
		} catch (fault) {
			return `could not read whether the owner ${owner} is trusted: ${why(fault)}`;
		}
	}
	if (trusts) return null;
	const where =
		trusted !== undefined
			? "factory.json's trusted list"
			: 'the Tracker (write access on GitHub, the Contributors group on Azure DevOps)';
	return `the owner ${owner} is not trusted by ${where}, so this Source cannot give the Go in their name: trust ${owner} there, or take "go": true off`;
}

export function startIntake(o: IntakeOptions): Promise<IntakeServer> {
	const now = o.now ?? (() => new Date());
	const say = o.say ?? sayLine;
	const { tracker } = o;
	const going = [...o.sources, ...(o.schedules ?? [])].filter(([, s]) => s.owner !== undefined);
	if (going.length > 0 && typeof tracker.assign !== 'function') {
		const names = going.map(([name]) => name).join(', ');
		return Promise.reject(
			new Error(`Source ${names}: go: true needs the Tracker's assign, which it lacks`)
		);
	}
	const failed = new Map<string, number[]>();
	// one delivery of a Source at a time, so two of the same key never make two Features
	const queues = new Map<string, Promise<unknown>>();

	const failedRecently = (name: string): number[] => {
		const at = now().getTime();
		const kept = (failed.get(name) ?? []).filter((t) => at - t < FAILED_WINDOW_MS);
		failed.set(name, kept);
		return kept;
	};

	const inTurn = <T>(name: string, work: () => Promise<T>): Promise<T> => {
		const turn = (queues.get(name) ?? Promise.resolve()).then(work, work);
		queues.set(
			name,
			turn.catch(() => undefined)
		);
		return turn;
	};

	const record = (name: string, delivery: string, answer: Answer) => {
		const entry: LogEntry = {
			at: now().toISOString(),
			source: name,
			delivery,
			answer: answer.status,
			outcome: answer.outcome,
			...(answer.feature === undefined ? {} : { feature: answer.feature }),
			...(answer.commented === undefined ? {} : { commented: answer.commented })
		};
		mkdirSync(dirname(o.log), { recursive: true });
		appendFileSync(o.log, `${JSON.stringify(entry)}\n`);
		const ref = answer.feature === undefined ? '' : ` ${tracker.reference(answer.feature).text}`;
		say(
			`Source ${name}, delivery ${delivery || '(no id)'}: ${String(answer.status)} ${answer.outcome}${ref}`
		);
	};

	// "happened again" on the open Feature, unless it was said there today
	const again = async (name: string, open: SourcedFeature): Promise<boolean> => {
		const said = (await tracker.comments(open.id)).filter((c) => c.body.includes(AGAIN_MARKER));
		const last = said.at(-1);
		if (last !== undefined && day(new Date(last.at)) === day(now())) return false;
		const since = last?.at ?? open.at;
		const times = repeatsSince(o.log, name, open.id, since) + 1;
		await tracker.comment(
			open.id,
			`Happened again, ${String(times)} ${times === 1 ? 'time' : 'times'} since ${localTime(new Date(since))}.\n\n${AGAIN_MARKER}`
		);
		return true;
	};

	// a schedule has no payload and no key path: its key is its name, so it makes nothing while its last Feature is open
	// The standing Go of a `go: true` Source (docs/adr/0003): assigned first, so the Go never lands on a Feature no one holds.
	const giveGo = async (name: string, feature: ItemId, owner: string): Promise<Answer> => {
		try {
			if (tracker.assign === undefined) throw new Error('the Tracker has no assign');
			await tracker.assign(feature, owner);
			await tracker.addSignal(feature, 'go');
			return { status: 201, outcome: 'made', feature };
		} catch (fault) {
			// the Feature is made, so a retry would only find it open: the sender is told it is made, and the Go waits for a person
			say(
				`Source ${name}: made ${tracker.reference(feature).text}, but could not give it the Go for ${owner}: ${why(fault)}. It waits for a person to give it.`
			);
			return { status: 201, outcome: 'made without the go', feature };
		}
	};

	const make = async (
		name: string,
		source: Pick<ServedSource, 'template' | 'key' | 'maxPerDay' | 'owner'>,
		payload: unknown,
		scheduled = false
	): Promise<Answer> => {
		let filled;
		try {
			filled = fillTemplate({
				template: source.template,
				source: name,
				payload,
				key: source.key,
				...(scheduled ? { fixedKey: name } : {}),
				now: now()
			});
		} catch (fault) {
			if (!(fault instanceof FeatureFileError)) throw fault;
			say(
				scheduled
					? `Source ${name}: the template does not make a Feature: ${why(fault)}`
					: `Source ${name}: the payload does not fill the template: ${why(fault)}`
			);
			return { status: 400, outcome: 'template failed' };
		}
		try {
			const found = await tracker.featuresFrom(name);
			const open = found.filter((f) => f.open && f.key === filled.key).at(-1);
			if (filled.key !== '' && open !== undefined) {
				if (scheduled) return { status: 200, outcome: 'still open', feature: open.id };
				const commented = await again(name, open);
				return { status: 200, outcome: 'again', feature: open.id, commented };
			}
			const today = day(now());
			const madeToday = found.filter((f) => day(new Date(f.at)) === today).length;
			if (madeToday >= source.maxPerDay) return { status: 200, outcome: 'day limit' };
			const made = await makeFeature(tracker, filled.plan, () => undefined);
			if (source.owner !== undefined) return await giveGo(name, made.feature, source.owner);
			return { status: 201, outcome: 'made', feature: made.feature };
		} catch (fault) {
			// the sender retries a 503; the key keeps a retry from making a second Feature
			say(`Source ${name}: the Tracker failed: ${why(fault)}`);
			return { status: 503, outcome: 'tracker failed' };
		}
	};

	const take = async (
		name: string,
		source: ServedSource,
		req: IncomingMessage
	): Promise<Answer> => {
		if (req.method !== 'POST') return { status: 405, outcome: 'not post' };
		// a sender guessing the secret is stopped before its body is read
		if (failedRecently(name).length >= FAILED_SIGNATURES) {
			req.resume();
			return { status: 429, outcome: 'too many bad signatures' };
		}
		const length = Number(header(req.headers, 'content-length') ?? 0);
		const body = length > BODY_LIMIT ? null : await readBody(req);
		if (body === null) {
			req.resume();
			return { status: 413, outcome: 'too large' };
		}
		const sentry = source.type === 'sentry';
		const right = sentry
			? sentrySignedRight(source.secret, req.headers, body)
			: signedRight(source.secret, req.headers, body, now());
		if (!right) {
			failedRecently(name).push(now().getTime());
			return { status: 401, outcome: 'bad signature' };
		}
		// Sentry sends every resource of the integration to the one URL; filtering stays in Sentry's alert rules
		if (sentry && header(req.headers, 'sentry-hook-resource') !== SENTRY_RESOURCE) {
			return { status: 200, outcome: 'other resource' };
		}
		let payload: unknown;
		try {
			payload = JSON.parse(body.toString('utf8'));
		} catch {
			return { status: 400, outcome: 'not json' };
		}
		if (sentry && lookup(payload, 'action') !== 'triggered') {
			return { status: 200, outcome: 'other resource' };
		}
		return inTurn(name, () => make(name, source, payload));
	};

	const answer = (res: ServerResponse, a: Answer) => {
		res.writeHead(a.status, {
			'content-type': 'application/json',
			...(a.status === 405 ? { allow: 'POST' } : {}),
			...(a.status === 413 ? { connection: 'close' } : {})
		});
		const said = {
			outcome: a.outcome,
			...(a.feature === undefined ? {} : { feature: a.feature })
		};
		res.end(JSON.stringify(said));
	};

	const server = createServer((req, res) => {
		const path = (req.url ?? '').split('?')[0] ?? '';
		const name = /^\/sources\/([\w.-]+)$/.exec(path)?.[1];
		const source = name === undefined ? undefined : o.sources.get(name);
		if (name === undefined || source === undefined) {
			req.resume();
			res.writeHead(404).end();
			return;
		}
		const delivery = deliveryId(req.headers);
		take(name, source, req).then(
			(a) => {
				record(name, delivery, a);
				answer(res, a);
			},
			(fault: unknown) => {
				say(`Source ${name}: ${why(fault)}`);
				if (!res.headersSent) res.writeHead(500).end();
			}
		);
	});

	// The next due time of each schedule, counted from the start: a time that passed while intake was down is not made up.
	const schedules = o.schedules ?? new Map<string, ScheduledSource>();
	const due = new Map<string, Date | null>();
	for (const [name, schedule] of schedules) due.set(name, nextDue(schedule.cron, now()));

	const tick = async (): Promise<void> => {
		const at = now();
		await Promise.all(
			[...schedules].map(async ([name, schedule]) => {
				const when = due.get(name);
				if (when === undefined || when === null || at < when) return;
				// the next time is counted from now, not from the one that came, so times missed while the machine slept make one Feature
				due.set(name, nextDue(schedule.cron, at));
				try {
					const made = await inTurn(name, () => make(name, schedule, undefined, true));
					record(name, `schedule-${when.toISOString()}`, made);
				} catch (fault) {
					say(`Source ${name}: ${why(fault)}`);
				}
			})
		);
	};

	const tickMs = o.tickMs ?? TICK_MS;

	return new Promise((done, fail) => {
		server.once('error', fail);
		server.listen(o.port, o.host, () => {
			const { address, port } = server.address() as AddressInfo;
			// the clock is watched only once intake is listening
			const timer =
				tickMs > 0 && schedules.size > 0 ? setInterval(() => void tick(), tickMs) : undefined;
			done({
				address,
				port,
				tick,
				close: () =>
					new Promise<void>((closed) => {
						clearInterval(timer);
						server.closeAllConnections();
						server.close(() => closed());
					})
			});
		});
	});
}

// What the command reads of the machine it runs on; a spec passes its own.
export interface IntakeHost extends Seams {
	readonly cwd: string;
	readonly env: Env;
	// ends intake; Ctrl-C or SIGTERM unless a spec passes its own
	readonly stop?: AbortSignal;
}

const refuse = (text: string) => {
	console.error(`nightjar: ${text}`);
	return 2;
};

function onSignals(): AbortSignal {
	const stop = new AbortController();
	process.once('SIGINT', () => stop.abort());
	process.once('SIGTERM', () => stop.abort());
	return stop.signal;
}

interface Served {
	readonly sources: Map<string, ServedSource>;
	readonly schedules: Map<string, ScheduledSource>;
	// why intake cannot start
	readonly faults: string[];
	// what intake leaves out
	readonly notes: string[];
}

// The webhook and schedule Sources intake runs, with their templates read and their secrets taken.
function served(config: Config, root: string, env: Env): Served {
	const sources = new Map<string, ServedSource>();
	const schedules = new Map<string, ScheduledSource>();
	const faults: string[] = [];
	const notes: string[] = [];
	for (const [name, source] of Object.entries(config.sources ?? {})) {
		const own: string[] = templateFaults(root, source.template).map(
			(f) => `template ${source.template}: ${f}`
		);
		const secret = source.secretEnv === undefined ? '' : (env[source.secretEnv] ?? '');
		if (source.type !== 'schedule') {
			if (source.secretEnv === undefined) {
				own.push('name the variable that holds its webhook secret, as secretEnv');
			} else if (secret === '') {
				own.push(`${source.secretEnv} is not set; put the webhook secret in that variable`);
			}
		}
		let cron: Cron | undefined;
		if (source.type === 'schedule') {
			try {
				cron = parseCron(source.cron ?? '');
			} catch (fault) {
				own.push(`cron: ${why(fault)}`);
			}
		}
		if (own.length > 0) {
			faults.push(...own.map((f) => `Source ${name}: ${f}`));
			continue;
		}
		// config load refuses go: true without an owner
		const owner = source.go === true ? source.owner : undefined;
		if (owner !== undefined) {
			notes.push(`Source ${name}: each Feature is assigned to ${owner} and given the Go`);
		}
		const template = readTemplate(root, source.template);
		const maxPerDay = source.maxPerDay ?? DEFAULT_MAX_PER_DAY;
		const going = owner === undefined ? {} : { owner };
		if (cron === undefined) {
			const key = source.key ?? (source.type === 'sentry' ? SENTRY_KEY : undefined);
			sources.set(name, {
				template,
				secret,
				type: source.type === 'sentry' ? 'sentry' : 'webhook',
				...(key === undefined ? {} : { key }),
				maxPerDay,
				...going
			});
		} else {
			schedules.set(name, { template, cron, maxPerDay, ...going });
		}
	}
	return { sources, schedules, faults, notes };
}

// 0 once it is told to stop, 2 when it cannot start.
export async function runIntakeCommand(argv: readonly string[], host: IntakeHost): Promise<number> {
	const args = parseIntakeArgs(argv);
	if (typeof args === 'string') return refuse(`${args}\n\n${INTAKE_USAGE}`);
	const env: Env = { ...host.env, GIT_TERMINAL_PROMPT: '0' };
	const top = await run('git', ['rev-parse', '--show-toplevel'], host.cwd, env);
	if (!top.ok) return refuse('not inside a git checkout; run intake in the repo.');
	const root = top.out.trim();
	let config: Config;
	let adapters: Adapters;
	try {
		config = loadConfig(root);
		const seams = {
			...(host.request === undefined ? {} : { request: host.request }),
			...(host.gh === undefined ? {} : { gh: host.gh })
		};
		adapters = await makeAdapters(config, root, env, seams);
	} catch (fault) {
		if (fault instanceof ConfigError) return refuse(fault.message);
		throw fault;
	}
	if (Object.keys(config.sources ?? {}).length === 0) {
		return refuse('factory.json names no sources for intake to run.');
	}
	const { writer } = adapters;
	const missing: string[] = [];
	if (typeof writer === 'string') {
		missing.push(`intake makes Features through createFeature: ${writer}`);
	}
	// the Tracker as the Code host wraps it keeps featuresFrom when it has one
	if (adapters.tracker.featuresFrom === undefined) {
		missing.push(
			'intake finds the Features a Source made through featuresFrom, which this Tracker lacks (docs/custom-adapters.md)'
		);
	}
	if (typeof writer === 'string' || !findsSources(writer) || missing.length > 0) {
		return refuse(missing.join('\nnightjar: '));
	}
	const { sources, schedules, faults, notes } = served(config, root, env);
	// a standing Go only for an owner the Tracker trusts, read before intake listens
	for (const [name, source] of [...sources, ...schedules]) {
		if (source.owner === undefined) continue;
		const fault = await goFault(writer, source.owner, config.trusted);
		if (fault !== null) faults.push(`Source ${name}: ${fault}`);
	}
	if (faults.length > 0) return refuse(faults.join('\nnightjar: '));
	if (sources.size === 0 && schedules.size === 0) {
		return refuse('factory.json names no webhook or schedule Source for intake to run.');
	}
	let server: IntakeServer;
	try {
		server = await startIntake({
			tracker: writer,
			sources,
			schedules,
			host: args.host,
			port: args.port,
			log: intakeLogPath(root)
		});
	} catch (fault) {
		if ((fault as NodeJS.ErrnoException).code === 'EADDRINUSE') {
			return refuse(
				`port ${String(args.port)} is taken; stop what uses it or pick another with --port.`
			);
		}
		return refuse(`cannot listen on ${args.host}: ${why(fault)}`);
	}
	// an IPv6 address is written in brackets in a URL
	const address = server.address.includes(':') ? `[${server.address}]` : server.address;
	const base = `http://${address}:${String(server.port)}`;
	sayLine(`intake on ${base}  (Ctrl-C to stop)`);
	for (const name of sources.keys()) sayLine(`Source ${name}: POST ${base}/sources/${name}`);
	for (const [name, schedule] of schedules) {
		const next = nextDue(schedule.cron, new Date());
		sayLine(`Source ${name}: next due ${next === null ? 'never' : localTime(next)}`);
	}
	for (const note of notes) sayLine(note);
	const stop = host.stop ?? onSignals();
	await new Promise<void>((done) => {
		if (stop.aborted) done();
		stop.addEventListener('abort', () => done(), { once: true });
	});
	await server.close();
	return 0;
}
