// One behaviour an Adapter must have, run in any test runner: `it(c.name, () => c.run(harness))`.
// A case throws an AssertionError when the Adapter falls short.
export interface ContractCase<Harness> {
	readonly name: string;
	readonly run: (harness: Harness) => Promise<void>;
}
