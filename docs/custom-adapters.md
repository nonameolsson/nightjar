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
		// { assignees, signals } of a Feature, which `nightjar <id>` reads before it claims one
		standing: todo('standing'),
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

To let Waiting on you in the live views list Features, give the Tracker one more optional method. A Tracker without it builds as before, and Waiting on you says the Tracker cannot list Features.

```js
		// the open Features assigned to a person that carry the needs info or needs a person Signal,
		// oldest first, each with `signal: 'needsInfo'` or `'human'` (needsInfo when it carries both);
		// read the Signal names from `signals`, never a tracker state
		waitingOn: todo('waitingOn'),
```

To let a Source's Features be found again on your Tracker, give it one more optional method. Without it, `nightjar doctor` still reads the Sources, but intake cannot tell what a Source made before.

```js
		// the Features, open or closed, whose body holds the marker `<!-- nightjar:source=NAME key=KEY -->`
		// of the Source `NAME`, oldest first, each as `{ id, key, open, at }` with `at` an ISO date;
		// search for the text `nightjar:source=NAME`, then read the first marker of each body yourself,
		// as a search may match more than that
		featuresFrom: todo('featuresFrom'),
```

To let a Source with `"go": true` give its Features the Go ([ADR 0003](adr/0003-a-source-may-give-a-standing-go.md)), give the Tracker two more optional methods. Without `assign`, intake and `nightjar doctor` refuse such a Source and name the method. Without `trusts`, they take the owner only from `factory.json`'s `trusted` list.

```js
		// assigns the Feature to `person`, so that with the Go it is among assignedFeatures(person)
		assign: todo('assign'),
		// whether `person` is trusted: on `trusted` when it is set, else by your Tracker's own default
		// (as write access is on GitHub); a person your Tracker does not know is not trusted
		trusts: todo('trusts'),
```

A Code host module is the same, exporting `createCodeHost` and returning `push`, `openPull`, `createDraft`, `editBody`, `placeReferences` and `comment`.

To let Nightjar answer feedback on a draft pull request, give the Code host two more optional methods. A Code host without them builds as before and gets no Feedback rounds; one with only one of them is refused at start.

```js
		// every piece of Feedback on the pull request, all pages of each list, in any order
		feedback: todo('feedback'),
		// answers one piece by its id; the body always ends with the footer
		reply: todo('reply'),
```

`feedback(pull)` resolves to a list of `Feedback`, a type exported from `@nonameolsson/nightjar`:

| Field      | What it is                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | The kind, a colon and your host's own id: `comment:123`, `review:45` or `check:678`. The prefix keeps ids from different lists of the host apart. |
| `kind`     | `comment`, `review` or `check`.                                                                                                                    |
| `author`   | The person, or for a check the app that ran it.                                                                                                    |
| `body`     | The text. A check's is its name, then the last 4 KB of its output.                                                                                 |
| `at`       | When it was said.                                                                                                                                  |
| `trusted`  | Whether its author is trusted, by the rule below. Only trusted feedback reaches the Coding agent.                                                  |
| `path`     | A line comment's file.                                                                                                                             |
| `line`     | A line comment's line, left out when the line is no longer on the head commit.                                                                     |
| `outdated` | `true` on a line comment whose line is gone from the head commit. It comes with `path` and no `line`.                                              |

What `feedback` returns: line comments, comments in the pull request's conversation, reviews that have a body (an approval with no body is not feedback, one with a body is), and checks on the head commit whose conclusion is `failure` or `timed_out`. A check that passed, was skipped or was neutral is not feedback.

**Nightjar's own words are never feedback.** Every comment and reply Nightjar posts ends with its footer (`FOOTER`, exported from `@nonameolsson/nightjar`: a blank line, `---`, then `_Built by Nightjar._`). Nightjar posts as the person signed in, often the same login as the reviewer, so the author cannot tell its words from theirs. Leave out every comment and review that ends with the footer, whoever its author. Your own `reply` must end its body with the footer too, or Nightjar would read its answers as new feedback.

Trust follows the Tracker's rule: the logins of `trusted` in `factory.json` when it is set, else your host's own default (write access on GitHub). A check's author is the app that ran it; the GitHub Code host trusts GitHub Actions, and the apps named in `codeHost.trustedChecks`.

`reply(pull, feedbackId, body)` answers a line comment in its thread. Anything else it answers as a comment on the pull request's conversation, which quotes the start of what it answers so the reader can tell which piece it is for. It fails when the host has no such feedback.

Ids are strings, spelled as your Tracker spells them (`42`, `PROJ-123`); Nightjar reads no meaning into them. It names a branch after the Feature id, with any character a git branch name cannot hold turned into a dash.

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

`codeHostHarness` is the same idea for a Code host: it takes no world and returns `{ codeHost, base, commit, branch, pull, close }`. A Code host with `feedback` and `reply` adds a `bench`, `{ give, thread }`: `give(pull, given)` puts feedback on a pull request the way a person or a check on your host would, and resolves to the id `feedback` reads it back by; `thread(pull, id)` resolves to the bodies of the replies in the thread of line comment `id`. A `given` says its `kind`, who said it (`author`, or the `name` of a check), its `body` (a check's `output`), and whether your host would trust it (`trusted`); a line comment has `on: { path, line }`, with a `line` of `null` for a line the head commit lost, and a check has a `conclusion`. The types are `TrackerHarness` and `CodeHostHarness`, with the `World*`, `PullView`, `FeedbackBench` and `Given` types they use, exported from `@nonameolsson/nightjar`. `src/fakes/harness.ts` in this repo holds a complete pair for the in-memory fakes.

Then run, from the repo:

```bash
nightjar contract ./tools/my-tracker.contract.js
```

The module may export `trackerHarness`, `codeHostHarness` or both; the suite of each runs, and the creation suite (`featureWriterContract`) too when the harness's Tracker has the `FeatureWriter` methods, the `waitingOn` suite (`waitingOnContract`) when it has `waitingOn`, the `ticketCounts` suite (`ticketCountsContract`) when it has `ticketCounts`, the `featuresFrom` suite (`sourcesContract`) when it has `featuresFrom`, the `assign` suite (`assignContract`, which checks `trusts` too when it is there) when it has `assign`, and the feedback suite (`feedbackContract`) when the harness's Code host has `feedback` and `reply`. The creation suite makes Features and Tickets on an empty world and reads them back through the Tracker's own methods. The command needs no test runner. It prints each behaviour and, for a failing one, why. Run over the minimal module above, whose methods are not written yet:

```
Tracker contract
  FAIL  names the signed-in person
        my-tracker: me is not written yet
  FAIL  lists the open Features assigned to a person that carry the Go, oldest first
        my-tracker: assignedFeatures is not written yet
  ...

12 of 12 behaviours fail.
```

Exit code 0 means every behaviour holds, 1 that at least one fails, 2 that the module could not be checked (it cannot be loaded, or exports no harness). The same list is available to your own test runner, as `trackerContract`, `featureWriterContract`, `waitingOnContract`, `ticketCountsContract`, `sourcesContract`, `assignContract`, `codeHostContract` and `feedbackContract` from `@nonameolsson/nightjar`: each case has a `name` and a `run(harness)`.

Check an Adapter before its first build, and again whenever you change it.
