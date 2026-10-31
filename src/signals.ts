// The Signals (GLOSSARY.md): the marks that steer a build. The build loop speaks only of these;
// each Tracker adapter shows them under names, never as tracker states (docs/adr/0002).
export const SIGNALS = ['go', 'ready', 'working', 'needsInfo', 'human'] as const;

export type Signal = (typeof SIGNALS)[number];

export type SignalNames = Readonly<Record<Signal, string>>;

// The names until factory.json can set them; the Go shares its name with ready for now.
export const FIXED_SIGNAL_NAMES: SignalNames = {
	go: 'ready-for-agent',
	ready: 'ready-for-agent',
	working: 'agent-working',
	needsInfo: 'needs-info',
	human: 'ready-for-human'
};
