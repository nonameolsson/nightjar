# Nightjar

Nightjar builds a repo's Features with nobody at the keyboard. It reads a Feature's Tickets from a Tracker, has a Coding agent (Claude Code) build each one on a single branch, and opens one draft pull request per Feature on a Code host.

Today the Tracker is GitHub Issues or Azure DevOps Boards, and the Code host is GitHub or Azure Repos, chosen apart. The words used here (Feature, Ticket, Signal, Go, …) are defined in [GLOSSARY.md](GLOSSARY.md).

## Platforms and requirements

- macOS, Linux, or WSL2 on Windows. On native Windows every command stops with a message saying so.
- Node 24 or later.
- `git`, in a checkout whose `origin` is the Code host's repo, which `git fetch` can read with your own git login.
- With GitHub as the Tracker or the Code host: [`gh`](https://cli.github.com/), signed in (`gh auth login`).
- With Azure DevOps Boards as the Tracker or Azure Repos as the Code host: the [Azure CLI](https://learn.microsoft.com/cli/azure/) signed in (`az login`), else a personal access token in `AZURE_DEVOPS_EXT_PAT`. Nightjar asks `az` first, and signs in once for both. The token needs Work Items (Read & write) for either; for the Tracker, unless `factory.json` sets `trusted`, Identity (Read); for Azure Repos, Code (Read & write). Nightjar pushes to Azure Repos with this sign-in as a header for `dev.azure.com` alone; it never writes it into a remote or a git config.
- [`claude`](https://claude.com/claude-code) (Claude Code), signed in. Nightjar bills your Claude plan. If `ANTHROPIC_API_KEY` is set it refuses to start, unless you pass `--use-api-key`.
- If your git setup signs commits, the signing key must be unlocked: Nightjar stops when git cannot sign.

## Install

> Not published to npm yet; until it is, install from a tarball (below). Check an install with `nightjar --help`.

Nightjar needs Node, but the repo it builds need not be a Node project. Install it once for your user, so the repo gets no `package.json` or `node_modules`:

```bash
npm i -g @nonameolsson/nightjar
nightjar init
```

Or run it without installing, each time through `npx`:

```bash
npx @nonameolsson/nightjar init
```

The commands below are written as `nightjar …`; with `npx`, put `npx @nonameolsson/nightjar` in its place. In a repo that is a Node project already, you can also pin the version with the repo, as a dev dependency, and run it as `npx nightjar …`:

```bash
npm i -D @nonameolsson/nightjar
```

From a tarball, built from a clone of this repo:

```bash
npm ci
npm pack
```

`npm pack` builds `dist/` first and writes `nonameolsson-nightjar-<version>.tgz`. Install that file the same way:

```bash
npm i -g /path/to/nonameolsson-nightjar-0.0.0.tgz
```

## Set up: `nightjar init`

In the repo you want built, run:

```bash
nightjar init
```

It asks for:

- the Tracker: `github`, `azure-devops` or `module` (your own, see [Another Tracker or Code host](#another-tracker-or-code-host)), and what that one needs: the `owner/name` repo on GitHub (it offers the one `origin` names), the organization, project and Feature type on Azure DevOps (and the type of a Ticket, which `nightjar create` needs), or the module's path;
- the Code host, the same way (on Azure Repos: organization, project and repo);
- the **check command**, which has no default: Nightjar assumes no language or toolchain, so it asks until you give one;
- the commands the agent may run, which it offers as the check command alone.

Then it writes `factory.json` (below), which you commit, and:

- **on GitHub** creates the Signal labels (`factory-go`, `ready-for-agent`, `agent-working`, `needs-info`, `ready-for-human`, or the names `factory.json` gives them), leaving any that exist as they are;
- **on Azure DevOps** says tags appear on first use, so there is nothing to create;
- checks every login it needs and says how to fix each one that is missing: `gh auth login`, `az login` or a token in `AZURE_DEVOPS_EXT_PAT`, and `claude auth login`.

It reads its answers from standard input, line by line, so a script can pipe them in; there is no need for a terminal. If `factory.json` is already there, `init` keeps it, asks nothing, and only creates the labels and checks the logins: run it that way after you have fixed a login, or when you join a repo that has one.

## Configure: `factory.json`

`nightjar init` writes this file. You can also write it by hand, at the root of the repo, and commit it. Nightjar refuses to start without one, and names each field that is wrong.

A minimal one needs a Tracker, a Code host, the check command, and the commands the agent may run:

```json
{
	"$schema": "https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json",
	"tracker": { "type": "github" },
	"codeHost": { "type": "github" },
	"check": "make check",
	"allowedCommands": ["make check", "make test"]
}
```

A full one:

```json
{
	"$schema": "https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json",
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
| `tracker`         | yes      | `{ "type": "github" }`: Features are issues, their Tickets sub-issues. `repo` (`owner/name`) is read from the `origin` remote when left out. Or `{ "type": "azure-devops" }` with `organization` (as in `dev.azure.com/<organization>`), `project`, and `featureType`, the work item type that plays the Feature (`Feature`, `Epic`, `Product Backlog Item`, …): its child work items are its Tickets. `ticketType`, optional, is the work item type `nightjar create` makes each Ticket as (`User Story`, `Product Backlog Item`, `Issue`, …). Or `{ "type": "module", "path": "./my-tracker.js" }`, with optional `options` handed to the module: see [Another Tracker or Code host](#another-tracker-or-code-host). |
| `codeHost`        | yes      | `{ "type": "github" }`: the branch is pushed to `origin` and a draft pull request opened. `repo` as above. Or `{ "type": "azure-devops" }` with `organization`, `project` and `repo`, the Git repo on Azure Repos the branch is pushed to and the draft pull request opened on. Or a `module`, as for `tracker`. |
| `check`           | yes      | The shell command that checks the work in the worktree, run after each Ticket. A non-zero exit means it failed. Nightjar assumes no language or toolchain, so there is no default.                                  |
| `allowedCommands` | yes      | What the agent may run, as Claude Code Bash permission patterns without `Bash( )`, such as `make test` or `make lint *`. Committing, pushing, switching branches, the network and `gh` stay denied whatever you list. The list may be empty. |
| `signals`         | no       | The name each Signal has on the Tracker (a label on GitHub, a tag on Azure DevOps). Leave out the ones you do not rename. Defaults are shown above. `needs-triage` and `wontfix` are refused: Nightjar never reads or sets them.          |
| `trusted`         | no       | The logins whose comments reach the agent (on Azure DevOps, sign-in names such as `ann@contoso.com`, in any case). Replaces the default: on GitHub anyone with write access, on Azure DevOps the members of the project's Contributors group.                                                                                                      |
| `setup`           | no       | A shell command run once in each new worktree before the first session, such as an install. If it fails, the Feature stops with a comment saying why.                                                              |
| `ports`           | no       | Reserve `count` (1 to 100) ports per run, held until the process ends so two runs never share one. `env` names the variables that carry them: the first name gets the first port, the next name the next, and so on. At most `count` names. |
| `rules`           | no       | A text file, relative to the repo root, added to the agent's prompt. Conventions normally live in `CLAUDE.md` or `AGENTS.md`.                                                                                       |
| `model`, `effort` | no       | The default model and effort of every session.                                                                                                                                                                      |
| `review`          | no       | The read-only review of the whole diff, run before the draft pull request opens. `enabled: false` switches it off (on by default); `model` and `effort` are the review's own, else the defaults above.            |
| `workflows`, `defaultWorkflow` | no | Work the repo adds to the build loop: see [Workflows](#workflows). A Feature picks a Workflow with a `**Workflow:**` line; `defaultWorkflow` is the one a Feature without the line gets. Left out, a build runs no Step. |

Model and effort are chosen, strongest first: the `--model` / `--effort` option, the Ticket's own `**Model:**` / `**Effort:**` line, then `factory.json`.

With Azure DevOps Boards as the Tracker, and the code on GitHub:

```json
{
	"$schema": "https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json",
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

Fully on Azure DevOps, with the code on Azure Repos:

```json
{
	"$schema": "https://unpkg.com/@nonameolsson/nightjar/schema/factory.schema.json",
	"tracker": {
		"type": "azure-devops",
		"organization": "contoso",
		"project": "Fabrikam",
		"featureType": "Feature"
	},
	"codeHost": {
		"type": "azure-devops",
		"organization": "contoso",
		"project": "Fabrikam",
		"repo": "fabrikam-app"
	},
	"check": "make check",
	"allowedCommands": ["make check", "make test"]
}
```

The JSON Schema for editor completion is `schema/factory.schema.json` in the package, published at the `$schema` URL above, so it works whether or not the repo installs Nightjar.

## Your own settings: `~/.config/nightjar/config.json`

What is yours rather than the repo's lives outside it, in `config.json` under `$XDG_CONFIG_HOME/nightjar/` (`~/.config/nightjar/` when `XDG_CONFIG_HOME` is not set). The file is optional, and so is each key:

```json
{
	"dailyUsd": 25,
	"assignee": "alice"
}
```

| Key        | Default                | What it does                                                                                                                                                |
| ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dailyUsd` | `60`                   | The estimated spend per local day in a repo, from its `.factory/runs.jsonl`, at which a run pauses. `--watch` looks again after 30 minutes.                                          |
| `assignee` | the signed-in person   | Whose Features to build: `--once`, `--watch` and `doctor` take the Features assigned to this login with the Go, and `nightjar <id>` refuses one assigned to anyone else. |
| `profile`  | none, the terminal's own login | Which Claude login the sessions use: a name (`work` is `~/.claude-work`), a path to the config folder, or `default` for `~/.claude`. `--profile` beats it. |

Nightjar refuses to start when the file is not JSON or a key is wrong or unknown, and names each one. `doctor` lists what it read.

## Another Tracker or Code host

Name your own Adapter in `factory.json` as a module, resolved from the repo's root, and check it before a build:

```json
{
	"tracker": { "type": "module", "path": "./tools/my-tracker.js" },
	"codeHost": { "type": "github" }
}
```

```bash
nightjar contract ./tools/my-tracker.contract.js
```

`nightjar contract` runs the same contract suite the built-in Adapters meet over the harnesses a module exports, prints every behaviour, names each one that fails, and exits 1 if any does. Nightjar refuses to start when a named module cannot be loaded or lacks a method of the interface. [docs/custom-adapters.md](docs/custom-adapters.md) has a minimal module and a test harness.

## Workflows

A repo can add its own work to a build without Nightjar knowing what that work is. A **Workflow** is a named list of **Steps** in `factory.json`. A Step is a prompt given to the agent, and the prompt may name any skill. Nightjar's loop stays fixed: it keeps the branch, the commits, the Signals and the pull request, and a Workflow can only add Steps to it.

A Feature picks a Workflow with a line anywhere in its body, in the same shape as a Ticket's Model line:

```markdown
**Workflow:** design-review
```

With no such line, the Feature gets `defaultWorkflow` if `factory.json` sets one, else no Step runs and the build is as it was. A name no Workflow has marks the Feature as needing info, with a comment naming the Workflows that exist.

A design review built on a skill, in this case [Impeccable](https://github.com/pbakaus/impeccable) (any skill the agent can load works the same way):

```json
{
	"ports": { "count": 1, "env": ["APP_PORT"] },
	"workflows": {
		"design-review": {
			"serve": "npm run dev -- --port $APP_PORT",
			"localNetwork": true,
			"allowedCommands": ["npx playwright test *"],
			"steps": [
				{
					"name": "critique",
					"prompt": "/impeccable critique the screens this Feature changed. Write what is wrong, worst first, to the notes folder.",
					"point": "afterAllTickets",
					"model": "opus"
				},
				{
					"name": "polish",
					"prompt": "/impeccable polish the screens, fixing what the critique in the notes folder found.",
					"point": "afterAllTickets",
					"until": "the critique's list is empty or only things a person must decide remain",
					"maxRounds": 3,
					"budgetUsd": 8
				}
			]
		}
	},
	"defaultWorkflow": "design-review"
}
```

A Step has:

| Key                | What it does                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`, `prompt`   | The Step's name, which its commit and the pull request body use, and what the agent is told. Nightjar adds the rule that nobody is at the keyboard: the agent decides, never asks in chat, and a question that truly blocks it goes into its structured answer, which makes the Step "blocked". |
| `point`            | `afterEachTicket` runs after each Ticket is built and checked. `afterAllTickets` runs once, after every Ticket, before the review; it runs only when every Ticket of the Feature is built, and gets the Feature's diff against the base branch, so the agent picks its own targets. |
| `model`, `effort`  | The Step's own; else the defaults. `--model` and `--effort` win over both.                                                                                                                                                           |
| `budgetUsd`        | The most one run of the Step may cost; a Ticket's budget when left out.                                                                                                                                                              |
| `until`, `maxRounds` | A condition in plain words. After each round the agent reports whether it holds, and Nightjar runs the Step again, in the same session, until it does or `maxRounds` (3 by default) is reached. What is left goes into the pull request body. |

A Workflow can also have `serve`, a command started in the background in the worktree before its Steps and stopped after them (it reads its port from the variables of `ports.env`, so `ports` is required); `allowedCommands` and `allowedTools`, which its Steps may use besides the usual ones; and `localNetwork`, which lets its Steps reach localhost and nothing else. The fixed deny rules (committing, pushing, switching branches, the outside network, `gh`) cannot be loosened by any of these.

Steps share one notes folder, `.factory/notes/` in the worktree, which is never committed. Nightjar passes nothing else from one Step to the next, so a Step that needs what an earlier one found reads it there.

What a Step changes goes through the check command and its fix rounds, then is committed on its own, with a message naming the Workflow and the Step. Steps count against the daily spend limit and show in the cost of the pull request. A Step that hits its budget or time limit, cannot get the check green, answers in a shape not known, or reports itself blocked has its changes thrown away; the later Steps still run, and the pull request opens with that Step listed as not done. A Step the branch already holds is not run again when a later run goes on.

`nightjar doctor` looks up each `/skill` a Step's prompt names among the skills a headless Claude session loads. A skill that is missing is an error for that Workflow only: a Feature that picks it stops with a comment, and the others build as usual. (A word like `/tmp/notes` is a path, not a skill; a bare `/word` in a prompt is read as one.)

## Write a Feature

What a Ticket must hold (acceptance criteria, blocking links, optional Model and Effort lines) is the [Ticket contract](docs/ticket-contract.md). Write a Feature and its Tickets by hand on the Tracker, as in [Give the Go](#give-the-go), or as one Markdown file in the contract's shape and let Nightjar make them through the configured Tracker:

```bash
nightjar create --dry-run plans/escape.md   # says what it would make
nightjar create plans/escape.md
```

`nightjar create` makes the Feature with no Signal and each Ticket ready, linked to its blockers. It works with GitHub Issues, with Azure DevOps Boards once `tracker.ticketType` is set, and with a Tracker module that makes Features ([docs/custom-adapters.md](docs/custom-adapters.md)).

The package ships a Claude Code skill, `nightjar-feature`, that writes that file from an idea agreed in the conversation and runs `nightjar create`; it needs no other skill. Copy it into the repo to use it:

```bash
mkdir -p .claude/skills
cp -R "$(npm root -g)/@nonameolsson/nightjar/skills/nightjar-feature" .claude/skills/
```

With Nightjar as a dev dependency, the package is at `node_modules/@nonameolsson/nightjar` instead, here and below.

## The Ticket contract

Every Ticket holds acceptance criteria (a checklist under an `Acceptance criteria` heading), optional blocking links to the Tickets that must be done first, and optional `**Model:**` and `**Effort:**` lines. The full contract, which holds on any Tracker, is in [docs/ticket-contract.md](docs/ticket-contract.md); the package ships it.

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
2. Add its Tickets as **child** work items. The Build order is: Predecessor links first (step 3), then backlog rank (the Stack Rank or Backlog Priority your process keeps), then, for the children nobody has ranked, the order they were linked to the Feature.
3. Mark the dependencies with **Predecessor** and **Successor** links: a Ticket waits for its Predecessors.
4. The `**Model:**` and `**Effort:**` lines work in the Markdown and the HTML editor alike.
5. Assign the Feature to yourself and add the Go tag. Signals are tags, which appear on first use, so there is nothing to create first.

A work item counts as closed once Azure DevOps has stamped its Closed Date, which it does when the item reaches a closed state of your process; Nightjar reads that date and never the state ([ADR 0002](docs/adr/0002-signals-are-labels-or-tags-never-states.md)). A known limit follows: a **Removed** work item has no Closed Date, so Nightjar counts it as open. A removed Ticket that still carries the ready Signal is built, and one that blocks others keeps them waiting. Take the ready Signal off a Ticket before you remove it, and the Predecessor links from it.

While it works, Nightjar puts the working Signal (`agent-working`) on the Feature. When it cannot build a Ticket it takes the ready Signal off, puts on needs info (`needs-info`) or needs a person (`ready-for-human`), and comments with why. Answer by commenting on the Ticket, put the ready Signal back on it, and give the Go again: the next run continues on the same branch and pull request. Only Trusted comments reach the agent. Nightjar never closes a Ticket and never sets a tracker state.

## Run

From anywhere inside the repo:

```bash
nightjar doctor
```

| Command                | What it does                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `init`                 | Asks for the Tracker and Code host, writes `factory.json`, creates the Signal labels, checks the logins. See [Set up](#set-up-nightjar-init). |
| `doctor`               | Checks this machine and `factory.json`, lists the Features it would build, builds nothing. Start here, and run it any time something is wrong. `--dry-run` is its old name and still works. |
| `--once`               | Builds the oldest Feature assigned to you with the Go, then exits.                                     |
| `--watch`              | Builds the Features assigned to you with the Go, oldest first, and looks again every 2 minutes.        |
| `<id>`                 | Builds that Feature now, by its id on the Tracker (`nightjar 42`, `#42`, or `nightjar PROJ-123` from a Tracker module). It refuses a Feature not assigned to you, without the Go, or already carrying the working Signal. |
| `--use-api-key`        | Lets the sessions bill `ANTHROPIC_API_KEY` instead of your Claude plan.                                |
| `--profile <name>`     | Runs the sessions as that Claude login: `~/.claude-NAME`, a path as the folder itself, or `default` for `~/.claude`. It drops `CLAUDE_CODE_OAUTH_TOKEN`, which would win over the folder. `doctor` and every build name the account, organization, plan and config folder first. |
| `--model <model>`      | The model of every session, over a Ticket's own line and `factory.json`.                               |
| `--effort <level>`     | The effort of every session, over a Ticket's own line and `factory.json`.                              |

Pick exactly one of `doctor`, `--once`, `--watch` or a Feature id. `--use-api-key`, `--profile`, `--model` and `--effort` combine with any of them. `nightjar create [--dry-run] FILE` makes a Feature from a file ([Write a Feature](#write-a-feature)), and `nightjar contract MODULE` checks an Adapter module.

Before building, Nightjar checks the API-key choice, Node, `factory.json`, the Tracker and Code host logins (`gh`, or the Azure DevOps sign-in, and the Azure Repos repo when it is the Code host), that `claude` is installed and signed in, and commit signing, and prints what it found. A build stops at the first check that fails; `doctor` runs every check and lists each result as `ok`, `FAIL` (with how to fix it) or `skip` (when `factory.json` could not be read, so the logins it names are not tried). `doctor` refuses a repo with no check command. Exit code 2 means it refused to start, or a check failed; the message says why.

Ctrl-C once stops the running session and hands its Ticket back; Ctrl-C again quits at once. On macOS, Nightjar keeps the machine awake while it runs.

## What you get

- **One branch** per Feature, `factory/<id>-<title-slug>`, with one commit per Ticket, pushed to `origin` on GitHub, or to the repo `factory.json` names on Azure Repos.
- **One draft pull request** per Feature. On GitHub each built GitHub issue is placed as `Closes #N`, so GitHub closes it on merge; any other Ticket by its plain reference, `AB#N` for an Azure DevOps work item (which the [Azure Boards app](https://learn.microsoft.com/azure/devops/boards/github/) links once it is installed on the repo) or a Tracker module's own text. On Azure Repos each built Ticket from Azure DevOps Boards in the same organization is attached as a linked work item and named `#N`; a Ticket from anywhere else is named in the description by a link to its page, because Azure Repos reads `#N` as one of its own work items. Azure Repos keeps 4000 characters of a description, so a longer one is cut, never its references. When every Ticket is built and the check passes, the Feature itself is placed as a reference too, the same way, so it closes or links with its Tickets. Nightjar never completes, abandons or publishes the pull request. When the review is on, its summary is the pull request's first comment.
- **`.factory/status.json`**: what Nightjar is doing now and what it did last, rewritten at every change.
- **`.factory/runs.jsonl`**: one line per session, with its outcome and cost. Each session's log is in `.factory/logs/`.
- **Worktrees** under `~/.nightjar/worktrees/`, outside your checkout, which is never touched. Add `.factory/` to the repo's `.gitignore`.

## Limits

Built in; only the spend per day is yours to set, as `dailyUsd` in [your config.json](#your-own-settings-confignightjarconfigjson):

| Limit                     | Value        |
| ------------------------- | ------------ |
| Spend per Ticket          | $15          |
| Minutes per Ticket        | 60           |
| Fix rounds per Ticket     | 3            |
| Question rounds per Ticket | 2           |
| Spend per review          | $3           |
| Minutes per review        | 10           |
| Spend per day             | $60, or `dailyUsd` |

A Ticket still unclear after its question rounds goes to a person.

Also:

- Claude Code is the only Coding agent.
- GitHub Issues and Azure DevOps Boards are the Trackers built in, and GitHub and Azure Repos the Code hosts; others are [custom Adapter modules](#another-tracker-or-code-host).
- The agent never commits, pushes, switches branches, reaches the network, or runs `gh`. Nightjar does that, and `factory.json` cannot loosen it.
- One run builds one Feature at a time.
- On Azure DevOps Boards a Removed work item counts as open, because it has no Closed Date and Nightjar never reads a state (see [Give the Go](#give-the-go)).
- When a Feature is complete, its draft pull request references the Feature as well as its Tickets: on GitHub `Closes #N` closes it on merge too.

## Status line plugin (optional)

The package ships `nightjar-status`, a Claude Code plugin that shows Nightjar in the status line (what it builds now, the day's spend) and toasts when it builds a Ticket, opens a pull request or needs a person. It reads `.factory/status.json`, so it works in any session opened in a checkout Nightjar runs in, and Nightjar works the same without it. Load it from the installed package:

```bash
claude --plugin-dir "$(npm root -g)/@nonameolsson/nightjar/plugin/nightjar-status"
```

The shape of the file is defined once, in `src/status-shape.ts`, which the package ships beside the plugin.

## Develop

```bash
npm ci
npm run check    # typecheck, lint, format check, every spec, then the build
```

See [CLAUDE.md](CLAUDE.md) for the layout and [docs/adr/](docs/adr/) for the decisions.

## Licence

MIT, see [LICENSE](LICENSE).
