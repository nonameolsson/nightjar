# Custom Adapter modules

Nightjar reads Tickets from a Tracker and opens pull requests on a Code host through an Adapter for each. GitHub is built in. A team on another Tracker or host writes its own Adapter as a module, names it in `factory.json`, and checks it with `nightjar contract` before trusting it with a build. The words are defined in [GLOSSARY.md](../GLOSSARY.md); the two Adapters are separate on purpose ([ADR 0001](adr/0001-tracker-and-code-host-are-separate-adapters.md)), so you can write one and keep GitHub for the other.

## Name the module

```json
{
	"tracker": { "type": "module", "path": "./tools/my-tracker.js", "options": { "project": "web" } },
	"codeHost": { "type": "github" },
	"check": "make check",
	"allowedCommands": ["make check"]
}
```

`codeHost` takes the same `{ "type": "module", "path": ... }`. The path is resolved from the repo's root. `options` is optional and is handed to the module as written, for its own settings; keep secrets out of it and read them from the environment.

Nightjar loads the module when it starts and refuses to go on if the module cannot be loaded, if it lacks the export below, or if what it builds lacks a method of the interface. The message names the field and what is missing.

## Write the module

A Tracker module exports `createTracker`, a Code host module exports `createCodeHost`; one module may export both. Each is called once with a context and returns the Adapter, or a promise of it.

| Context field | What it is                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------- |
| `root`        | The repo's root.                                                                              |
| `options`     | `options` from `factory.json`, or `{}`.                                                       |
| `signals`     | The name each Signal has on your Tracker (`go`, `ready`, `working`, `needsInfo`, `human`).    |
| `trusted`     | `trusted` from `factory.json`. Left out, your Tracker's own default applies.                 |

The interfaces are `Tracker` and `CodeHost`, exported as types from `@nonameolsson/nightjar` (`dist/tracker.d.ts` and `dist/code-host.d.ts` hold each method's meaning). A minimal Tracker module, to be filled in with calls to your system:

```js
// tools/my-tracker.js
/** @import { AdapterContext, Tracker } from '@nonameolsson/nightjar' */

/**
 * @param {AdapterContext} context
 * @returns {Tracker}
 */
export function createTracker({ options, signals, trusted }) {
	const todo = (what) => () => {
		throw new Error(`my-tracker: ${what} is not written yet`);
	};
	return {
		// the signed-in person
		me: todo('me'),
		// the open Features assigned to a person that carry the Go, oldest first
		assignedFeatures: todo('assignedFeatures'),
		feature: todo('feature'),
		// the Feature's Tickets in its own child order, each with its blockers
		tickets: todo('tickets'),
		// oldest first; `trusted` says whether the Coding agent may read the comment
		comments: todo('comments'),
		// show a Signal as a label, a tag, whatever your Tracker has; never as a state
		addSignal: todo('addSignal'),
		// a Signal the item does not carry is no fault
		removeSignal: todo('removeSignal'),
		comment: todo('comment'),
		// the text the Code host puts in a pull request to link a Ticket
		reference: (id) => ({ id, text: `#${id}` })
	};
}
```

To let `nightjar create` make Features on your Tracker ([ticket-contract.md](ticket-contract.md)), give it the three methods of the optional `FeatureWriter` interface too. A Tracker with none of them builds as before; one with some and not all is refused at start.

```js
		// a Feature that carries no Signal and is assigned to no one; resolves to its id
		createFeature: todo('createFeature'),
		// a Ticket made the Feature's last child, carrying no Signal; resolves to its id
		createTicket: todo('createTicket'),
		// links the first id as blocked by the second, so tickets() reads the blocker back
		block: todo('block'),
```

A Code host module is the same, exporting `createCodeHost` and returning `push`, `openPull`, `createDraft`, `editBody`, `placeReferences` and `comment`.

Ids are numbers. A Tracker whose items are keyed otherwise maps its keys to numbers inside the module.

## Test the module

The contract suite is the list of behaviours every Adapter must keep, built in or yours. To run it, a test module hands Nightjar a harness for each Adapter: a function that makes the Adapter over an empty, throwaway instance of your system.

```js
// tools/my-tracker.contract.js
import { DEFAULT_SIGNAL_NAMES } from '@nonameolsson/nightjar';
import { createTracker } from './my-tracker.js';

// `world` is what the Tracker must hold for the case: a signed-in person, the people it trusts by
// default, and items (Features and Tickets) with their assignees, Signals, children, blockers and comments.
export async function trackerHarness(world) {
	const system = await startTestInstance(); // your own set-up
	await system.load(world.items);
	const tracker = await createTracker({
		root: process.cwd(),
		options: {},
		signals: DEFAULT_SIGNAL_NAMES,
		trusted: world.trusted
	});
	return {
		tracker,
		// the id your Tracker gave the item the world calls `key`
		id: (key) => system.idOf(key),
		// runs after the case, pass or fail
		close: () => system.stop()
	};
}
```

`codeHostHarness` is the same idea for a Code host: it takes no world and returns `{ codeHost, base, commit, branch, pull, close }`. The types are `TrackerHarness` and `CodeHostHarness`, with the `World*` and `PullView` types they use, exported from `@nonameolsson/nightjar`. `src/fakes/harness.ts` in this repo holds a complete pair for the in-memory fakes.

Then run, from the repo:

```bash
npx nightjar contract ./tools/my-tracker.contract.js
```

The module may export `trackerHarness`, `codeHostHarness` or both; the suite of each runs, and the creation suite (`featureWriterContract`) too when the harness's Tracker has the `FeatureWriter` methods. The creation suite makes Features and Tickets on an empty world and reads them back through the Tracker's own methods. The command needs no test runner. It prints each behaviour and, for a failing one, why. Run over the minimal module above, whose methods are not written yet:

```
Tracker contract
  FAIL  names the signed-in person
        my-tracker: me is not written yet
  FAIL  lists the open Features assigned to a person that carry the Go, oldest first
        my-tracker: assignedFeatures is not written yet
  ...

11 of 11 behaviours fail.
```

Exit code 0 means every behaviour holds, 1 that at least one fails, 2 that the module could not be checked (it cannot be loaded, or exports no harness). The same list is available to your own test runner, as `trackerContract`, `featureWriterContract` and `codeHostContract` from `@nonameolsson/nightjar`: each case has a `name` and a `run(harness)`.

Check an Adapter before its first build, and again whenever you change it.
