# Nightjar

Nightjar builds a repo's Features with nobody at the keyboard. It reads a Feature's Tickets from a Tracker, has a Coding agent (Claude Code) build each one on a single branch, and opens one draft pull request per Feature on a Code host.

Today the Tracker is GitHub Issues or Azure DevOps Boards, and the Code host is GitHub. The words used here (Feature, Ticket, Signal, Go, …) are defined in [GLOSSARY.md](GLOSSARY.md).

## Requirements

- macOS, Linux, or WSL2 on Windows. Native Windows is not supported.
- Node 24 or later.
- `git`, in a checkout whose `origin` is the GitHub repo.
- [`gh`](https://cli.github.com/), signed in (`gh auth login`).
- With Azure DevOps Boards as the Tracker: the [Azure CLI](https://learn.microsoft.com/cli/azure/) signed in (`az login`), else a personal access token in `AZURE_DEVOPS_EXT_PAT` with Work Items (Read & write) and, unless `factory.json` sets `trusted`, Identity (Read). Nightjar asks `az` first.
- [`claude`](https://claude.com/claude-code) (Claude Code), signed in. Nightjar bills your Claude plan. If `ANTHROPIC_API_KEY` is set it refuses to start, unless you pass `--use-api-key`.
- If your git setup signs commits, the signing key must be unlocked: Nightjar stops when git cannot sign.

## Install

> Not published to npm yet. Until it is, install from a tarball (below).

From npm, in the repo you want built:

```bash
npm i -D @nonameolsson/nightjar
npx nightjar --dry-run
```

From a tarball, built from a clone of this repo:

```bash
npm ci
npm pack
```

`npm pack` builds `dist/` first and writes `nonameolsson-nightjar-<version>.tgz`. Install that file in the repo you want built:

```bash
npm i -D /path/to/nonameolsson-nightjar-0.0.0.tgz
```

## Configure: `factory.json`

Put a `factory.json` at the root of the repo and commit it. Nightjar refuses to start without one, and names each field that is wrong.

A minimal one needs a Tracker, a Code host, the check command, and the commands the agent may run:

```json
{
	"$schema": "./node_modules/@nonameolsson/nightjar/schema/factory.schema.json",
	"tracker": { "type": "github" },
	"codeHost": { "type": "github" },
	"check": "make check",
	"allowedCommands": ["make check", "make test"]
}
```

A full one:

```json
{
	"$schema": "./node_modules/@nonameolsson/nightjar/schema/factory.schema.json",
	"tracker": { "type": "github", "repo": "acme/widgets" },
	"codeHost": { "type": "github", "repo": "acme/widgets" },
	"check": "make check",
	"allowedCommands": ["make check", "make test", "make lint *"],
	"signals": {
		"go": "factory-go",
		"ready": "ready-for-agent",
		"working": "agent-working",
		"needsInfo": "needs-info",
		"human": "ready-for-human"
	},
	"trusted": ["alice", "bob"],
	"setup": "make install",
	"ports": { "count": 5, "env": ["APP_PORT", "DB_PORT"] },
	"rules": "docs/factory-rules.md",
	"model": "sonnet",
	"effort": "high",
	"review": { "enabled": true, "model": "opus", "effort": "high" }
}
```

| Key               | Required | What it does                                                                                                                                                                                                       |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tracker`         | yes      | `{ "type": "github" }`: Features are issues, their Tickets sub-issues. `repo` (`owner/name`) is read from the `origin` remote when left out. Or `{ "type": "azure-devops" }` with `organization` (as in `dev.azure.com/<organization>`), `project`, and `featureType`, the work item type that plays the Feature (`Feature`, `Epic`, `Product Backlog Item`, …): its child work items are its Tickets. Or `{ "type": "module", "path": "./my-tracker.js" }`, with optional `options` handed to the module: see [Another Tracker or Code host](#another-tracker-or-code-host). |
| `codeHost`        | yes      | `{ "type": "github" }`: the branch is pushed to `origin` and a draft pull request opened. `repo` as above. Or a `module`, as for `tracker`.                                                                         |
| `check`           | yes      | The shell command that checks the work in the worktree, run after each Ticket. A non-zero exit means it failed. Nightjar assumes no language or toolchain, so there is no default.                                  |
| `allowedCommands` | yes      | What the agent may run, as Claude Code Bash permission patterns without `Bash( )`, such as `make test` or `make lint *`. Committing, pushing, switching branches, the network and `gh` stay denied whatever you list. The list may be empty. |
| `signals`         | no       | The name each Signal has on the Tracker (a label on GitHub, a tag on Azure DevOps). Leave out the ones you do not rename. Defaults are shown above. `needs-triage` and `wontfix` are refused: Nightjar never reads or sets them.          |
| `trusted`         | no       | The logins whose comments reach the agent (on Azure DevOps, sign-in names such as `ann@contoso.com`, in any case). Replaces the default: on GitHub anyone with write access, on Azure DevOps the members of the project's Contributors group.                                                                                                      |
| `setup`           | no       | A shell command run once in each new worktree before the first session, such as an install. If it fails, the Feature stops with a comment saying why.                                                              |
| `ports`           | no       | Reserve `count` (1 to 100) ports per run, held until the process ends so two runs never share one. `env` names the variables that carry them: the first name gets the first port, the next name the next, and so on. At most `count` names. |
| `rules`           | no       | A text file, relative to the repo root, added to the agent's prompt. Conventions normally live in `CLAUDE.md` or `AGENTS.md`.                                                                                       |
| `model`, `effort` | no       | The default model and effort of every session.                                                                                                                                                                      |
| `review`          | no       | The read-only review of the whole diff, run before the draft pull request opens. `enabled: false` switches it off (on by default); `model` and `effort` are the review's own, else the defaults above.            |

Model and effort are chosen, strongest first: the `--model` / `--effort` option, the Ticket's own `**Model:**` / `**Effort:**` line, then `factory.json`.

With Azure DevOps Boards as the Tracker, and the code on GitHub:

```json
{
	"$schema": "./node_modules/@nonameolsson/nightjar/schema/factory.schema.json",
	"tracker": {
		"type": "azure-devops",
		"organization": "contoso",
		"project": "Fabrikam",
		"featureType": "Feature"
	},
	"codeHost": { "type": "github" },
	"check": "make check",
	"allowedCommands": ["make check", "make test"]
}
```

The JSON Schema for editor completion is at `schema/factory.schema.json` in the package.

## Another Tracker or Code host

Name your own Adapter in `factory.json` as a module, resolved from the repo's root, and check it before a build:

```json
{
	"tracker": { "type": "module", "path": "./tools/my-tracker.js" },
	"codeHost": { "type": "github" }
}
```

```bash
npx nightjar contract ./tools/my-tracker.contract.js
```

`nightjar contract` runs the same contract suite the built-in Adapters meet over the harnesses a module exports, prints every behaviour, names each one that fails, and exits 1 if any does. Nightjar refuses to start when a named module cannot be loaded or lacks a method of the interface. [docs/custom-adapters.md](docs/custom-adapters.md) has a minimal module and a test harness.

## Give the Go

Nightjar builds a Feature that is **assigned to you** and carries the **Go** Signal (the label `factory-go` by default). Nothing else starts a build.

1. Write the Feature as an issue, with its spec in the body.
2. Add its Tickets as **sub-issues**. Each Ticket holds its acceptance criteria in the body.
3. Mark the dependencies between Tickets with GitHub's **blocked by** links. Tickets are built in that order, then in the Feature's own child order. A Ticket is built only when the Signal ready (`ready-for-agent` by default) is on it and everything blocking it is closed or already built on the branch.
4. Optionally, give a Ticket its own model and effort, in lines in the body:

   ```
   **Model:** opus
   **Effort:** high
   ```

   A Ticket without them uses the defaults from `factory.json`.
5. Assign the Feature to yourself and add the Go label.

On Azure DevOps Boards the same steps read:

1. Write the Feature as a work item of the type `featureType` names, with its spec in the Description.
2. Add its Tickets as **child** work items. They are built in backlog order, then the ones nobody has ordered in the order they were linked.
3. Mark the dependencies with **Predecessor** and **Successor** links: a Ticket waits for its Predecessors.
4. The `**Model:**` and `**Effort:**` lines work in the Markdown and the HTML editor alike.
5. Assign the Feature to yourself and add the Go tag. Signals are tags, which appear on first use, so there is nothing to create first.

A work item counts as closed once Azure DevOps has stamped its Closed Date, which it does when the item reaches a closed state of your process; Nightjar reads that date and never the state.

While it works, Nightjar puts the working Signal (`agent-working`) on the Feature. When it cannot build a Ticket it takes the ready Signal off, puts on needs info (`needs-info`) or needs a person (`ready-for-human`), and comments with why. Answer by commenting on the Ticket, put the ready Signal back on it, and give the Go again: the next run continues on the same branch and pull request. Only Trusted comments reach the agent. Nightjar never closes a Ticket and never sets a tracker state.

## Run

From anywhere inside the repo:

```bash
npx nightjar --dry-run
```

| Command                | What it does                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `--dry-run`            | Checks this machine and `factory.json`, lists the Features it would build, builds nothing. Start here. |
| `--once`               | Builds the oldest Feature assigned to you with the Go, then exits.                                     |
| `--watch`              | Builds the Features assigned to you with the Go, oldest first, and looks again every 2 minutes.        |
| `<number>`             | Builds that Feature now (`nightjar 42`; `#42` also works).                                             |
| `--use-api-key`        | Lets the sessions bill `ANTHROPIC_API_KEY` instead of your Claude plan.                                |
| `--model <model>`      | The model of every session, over a Ticket's own line and `factory.json`.                               |
| `--effort <level>`     | The effort of every session, over a Ticket's own line and `factory.json`.                              |

Pick exactly one of `--dry-run`, `--once`, `--watch` or a Feature number. `--use-api-key`, `--model` and `--effort` combine with any of them.

Before building, Nightjar checks the API-key choice, Node, `factory.json`, the Tracker login (`gh`, or the Azure DevOps sign-in), `claude`, and commit signing, and prints what it found. Exit code 2 means it refused to start; the message says why.

Ctrl-C once stops the running session and hands its Ticket back; Ctrl-C again quits at once. On macOS, Nightjar keeps the machine awake while it runs.

## What you get

- **One branch** per Feature, `factory/<number>-<title-slug>`, with one commit per Ticket, pushed to `origin`.
- **One draft pull request** per Feature, with each built Ticket referenced by `#N`, or `AB#N` for an Azure DevOps work item, which the [Azure Boards app](https://learn.microsoft.com/azure/devops/boards/github/) links once it is installed on the repo. When the review is on, its summary is the pull request's first comment.
- **`.factory/status.json`**: what Nightjar is doing now and what it did last, rewritten at every change.
- **`.factory/runs.jsonl`**: one line per session, with its outcome and cost. Each session's log is in `.factory/logs/`.
- **Worktrees** under `~/.nightjar/worktrees/`, outside your checkout, which is never touched. Add `.factory/` to the repo's `.gitignore`.

## Limits

Built in, not yet configurable:

| Limit                     | Value        |
| ------------------------- | ------------ |
| Spend per Ticket          | $15          |
| Minutes per Ticket        | 60           |
| Fix rounds per Ticket     | 3            |
| Question rounds per Ticket | 2           |
| Spend per review          | $3           |
| Minutes per review        | 10           |
| Spend per day             | $60          |

A Ticket still unclear after its question rounds goes to a person.

Also:

- Claude Code is the only Coding agent.
- GitHub Issues and Azure DevOps Boards are the Trackers built in, and GitHub the only Code host; others are [custom Adapter modules](#another-tracker-or-code-host).
- The agent never commits, pushes, switches branches, reaches the network, or runs `gh`. Nightjar does that, and `factory.json` cannot loosen it.
- One run builds one Feature at a time.

## Coming

Planned, not built yet:

- `nightjar init`: asks for the Tracker and Code host, writes `factory.json`, creates the Signal labels, checks the logins.
- `nightjar doctor`: re-runs those checks at any time (today's `--dry-run`).
- Azure Repos as a Code host.
- A skill that writes a Feature and its Tickets through the configured Tracker.
- Publishing to npm.

## Develop

```bash
npm ci
npm run check    # typecheck, lint, format check, every spec, then the build
```

See [CLAUDE.md](CLAUDE.md) for the layout and [docs/adr/](docs/adr/) for the decisions.

## Licence

MIT, see [LICENSE](LICENSE).
