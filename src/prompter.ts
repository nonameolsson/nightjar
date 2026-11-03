// Interactive prompts on a terminal: select, multi-select, text and confirm. Each gives null when the person cancels.
import * as clack from '@clack/prompts';

export interface Choice {
	readonly value: string;
	readonly label: string;
	readonly hint?: string;
}

export interface Prompter {
	// `accept` gives the problem with an answer, or null when it will do; an empty answer takes `fallback`
	text(
		message: string,
		fallback: string | undefined,
		accept: (text: string) => string | null
	): Promise<string | null>;
	select(message: string, choices: readonly Choice[], initial?: string): Promise<string | null>;
	multiselect(
		message: string,
		choices: readonly Choice[],
		initial: readonly string[]
	): Promise<string[] | null>;
	confirm(message: string, initial: boolean): Promise<boolean | null>;
	// context above the next question; it may run over several lines
	note(text: string): void;
}

const orNull = <T>(got: T): Exclude<T, symbol> | null =>
	typeof got === 'symbol' ? null : (got as Exclude<T, symbol>);

export function clackPrompter(): Prompter {
	return {
		text: async (message, fallback, accept) =>
			orNull(
				await clack.text({
					message,
					...(fallback === undefined ? {} : { placeholder: fallback, defaultValue: fallback }),
					validate: (value) => accept((value ?? '').trim() || (fallback ?? '')) ?? undefined
				})
			)?.trim() ?? null,
		select: async (message, choices, initial) =>
			orNull(
				await clack.select({
					message,
					options: [...choices],
					...(initial === undefined ? {} : { initialValue: initial })
				})
			),
		multiselect: async (message, choices, initial) =>
			orNull(
				await clack.multiselect({
					message: `${message} (space selects, enter confirms)`,
					options: [...choices],
					initialValues: [...initial],
					required: false
				})
			),
		confirm: async (message, initial) =>
			orNull(await clack.confirm({ message, initialValue: initial })),
		note: (text) => {
			clack.log.info(text);
		}
	};
}
