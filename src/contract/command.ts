// `nightjar contract MODULE`: checks a module's Adapters against the contract suites.
import { importModule } from '../adapter-module.js';
import { ContractRefusal, formatReport, runContract } from './run.js';
import { why } from '../say.js';

export const CONTRACT_USAGE = `usage: nightjar contract MODULE

  MODULE  a module, as a path from here, that exports trackerHarness and/or codeHostHarness;
          runs the Tracker and Code host contract suites over them and names each behaviour that fails`;

// 0 when every behaviour holds, 1 when one fails, 2 when the module could not be checked.
export async function runContractCommand(argv: readonly string[]): Promise<number> {
	const [path, ...rest] = argv;
	if (path === undefined || rest.length > 0) {
		console.error(
			`nightjar: ${path === undefined ? 'say which module' : 'one module at a time'}\n\n${CONTRACT_USAGE}`
		);
		return 2;
	}
	let exports: Record<string, unknown>;
	try {
		exports = await importModule(path, process.cwd());
	} catch (fault) {
		console.error(`nightjar: contract: cannot load ${path}: ${why(fault)}`);
		return 2;
	}
	try {
		const report = await runContract(exports);
		console.log(formatReport(report));
		return report.failed === 0 ? 0 : 1;
	} catch (fault) {
		if (!(fault instanceof ContractRefusal)) throw fault;
		console.error(`nightjar: contract: ${path} ${fault.message}`);
		return 2;
	}
}
