// The Signals (GLOSSARY.md): shown under names a Tracker configures, never as tracker states (docs/adr/0002).
export const SIGNALS = ['go', 'ready', 'working', 'needsInfo', 'human'] as const;

export type Signal = (typeof SIGNALS)[number];

export type SignalNames = Readonly<Record<Signal, string>>;

// The names factory.json leaves unset: the Go has a mark of its own; the rest match the triage roles.
export const DEFAULT_SIGNAL_NAMES: SignalNames = {
	go: 'factory-go',
	ready: 'ready-for-agent',
	working: 'agent-working',
	needsInfo: 'needs-info',
	human: 'ready-for-human'
};

// Triage roles of someone else's process: Nightjar never reads or sets them, so no Signal may take one.
export const RESERVED_NAMES = ['needs-triage', 'wontfix'] as const;
