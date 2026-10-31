// Adapters a repo brings itself: the module factory.json names exports a function that builds the
// Tracker or the Code host (docs/custom-adapters.md). A module that falls short is refused at start.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CodeHost } from './code-host.js';
import { CONFIG_FILE, ConfigError } from './config.js';
import type { SignalNames } from './signals.js';
import type { Tracker } from './tracker.js';

// What Nightjar hands the function that builds an adapter.
export interface AdapterContext {
	// the repo's root, which the module path is resolved from
	readonly root: string;
	// factory.json's `options` for this adapter, as written
	readonly options: Readonly<Record<string, unknown>>;
	// the name each Signal has on the Tracker
	readonly signals: SignalNames;
	// factory.json's `trusted`; left out, the Tracker's own default applies
	readonly trusted?: readonly string[];
}

export type TrackerFactory = (context: AdapterContext) => Tracker | Promise<Tracker>;
export type CodeHostFactory = (context: AdapterContext) => CodeHost | Promise<CodeHost>;

// Typed as records, so a method added to an interface fails to compile until it is listed here.
const TRACKER_METHODS: Record<keyof Tracker, true> = {
	me: true,
	assignedFeatures: true,
	feature: true,
	tickets: true,
	comments: true,
	addSignal: true,
	removeSignal: true,
	comment: true,
	reference: true
};

const CODE_HOST_METHODS: Record<keyof CodeHost, true> = {
	push: true,
	openPull: true,
	createDraft: true,
	editBody: true,
	placeReferences: true,
	comment: true
};

export interface ModuleSpec {
	readonly path: string;
	readonly options?: Readonly<Record<string, unknown>> | undefined;
}

interface Kind {
	// the field in factory.json
	readonly field: 'tracker' | 'codeHost';
	readonly noun: string;
	readonly factory: string;
	readonly methods: readonly string[];
}

const TRACKER: Kind = {
	field: 'tracker',
	noun: 'Tracker',
	factory: 'createTracker',
	methods: Object.keys(TRACKER_METHODS)
};

const CODE_HOST: Kind = {
	field: 'codeHost',
	noun: 'Code host',
	factory: 'createCodeHost',
	methods: Object.keys(CODE_HOST_METHODS)
};

const said = (fault: unknown) => (fault instanceof Error ? fault.message : String(fault));

export async function importModule(path: string, base: string): Promise<Record<string, unknown>> {
	return (await import(/* @vite-ignore */ pathToFileURL(resolve(base, path)).href)) as Record<
		string,
		unknown
	>;
}

async function build(kind: Kind, spec: ModuleSpec, context: AdapterContext): Promise<unknown> {
	const where = `${CONFIG_FILE}: ${kind.field}:`;
	let exports: Record<string, unknown>;
	try {
		exports = await importModule(spec.path, context.root);
	} catch (fault) {
		throw new ConfigError(`${where} cannot load ${spec.path}: ${said(fault)}`);
	}
	const factory = exports[kind.factory];
	if (typeof factory !== 'function') {
		throw new ConfigError(
			`${where} ${spec.path} does not export ${kind.factory}, a function that builds the ${kind.noun}`
		);
	}
	let built: unknown;
	try {
		built = await (factory as (context: AdapterContext) => unknown)(context);
	} catch (fault) {
		throw new ConfigError(`${where} ${kind.factory} in ${spec.path} failed: ${said(fault)}`);
	}
	const have = (built ?? {}) as Record<string, unknown>;
	const missing = kind.methods.filter((name) => typeof have[name] !== 'function');
	if (missing.length > 0) {
		throw new ConfigError(
			`${where} ${kind.factory} in ${spec.path} returned a ${kind.noun} without these methods: ${missing.join(', ')}`
		);
	}
	return built;
}

export async function trackerFromModule(
	spec: ModuleSpec,
	context: Omit<AdapterContext, 'options'>
): Promise<Tracker> {
	return (await build(TRACKER, spec, { ...context, options: spec.options ?? {} })) as Tracker;
}

export async function codeHostFromModule(
	spec: ModuleSpec,
	context: Omit<AdapterContext, 'options'>
): Promise<CodeHost> {
	return (await build(CODE_HOST, spec, { ...context, options: spec.options ?? {} })) as CodeHost;
}
