// One rule an Adapter must keep; any test runner runs it as `it(c.name, () => c.run(harness))`.
export interface ContractCase<Harness> {
	readonly name: string;
	readonly run: (harness: Harness) => Promise<void>;
}
