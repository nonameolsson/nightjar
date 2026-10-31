// Only the part of Claude Code's mod API that nightjar-status calls; the engine supplies the real one.
declare module 'claude-code' {
	interface Run {
		exitCode: number;
		stdout: string;
	}
	export interface EngineInterface {
		process: { run(argv: string[]): Promise<Run> };
		fs: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> };
		ui: {
			status(text: string | undefined): void;
			toast(text: string, options?: { timeoutMs?: number }): void;
		};
		clock: { now(): Promise<number>; every(ms: number, fn: () => void): void };
	}
	export type Register = (
		on: (
			event: 'session.start',
			hook: (
				$: EngineInterface,
				e: unknown,
				next: (e: unknown) => Promise<unknown>
			) => Promise<unknown>
		) => void
	) => void;
}
