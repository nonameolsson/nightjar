<h1 align="center">
  <img src="docs/design/banner.webp" alt="Nightjar: the software factory that works while you are sleeping">
</h1>

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

Nightjar needs Node, but the repo it builds need not be a Node project. It is a tool you run on a machine, like `gh` or `claude`: it works in worktrees outside your checkout and uses that machine's logins. Only `factory.json` belongs to the repo.

| You are…                                                              | Install                         |
| --------------------------------------------------------------------- | ------------------------------- |
| Running it yourself, on any repo (the usual case)                     | Globally, once for your user    |
| Trying it, or running it now and then                                 | Not at all: use `npx`           |
| In a Node repo where everyone, or CI, must run the same version       | Pin it as a dev dependency      |

**Globally** keeps `package.json` and `node_modules` out of the repo, so it works the same for a Python, Go or Node project:

```bash
npm i -g @nonameolsson/nightjar
nightjar init
```

**With `npx`**, nothing is installed; each command fetches the package:

```bash
npx @nonameolsson/nightjar init
```

The commands below are written as `nightjar …`; with `npx`, put `npx @nonameolsson/nightjar` in its place.

**As a dev dependency**, the version is locked with the repo, so a team and CI all run the same one. Use it in a repo that is a Node project already, and run it as `npx nightjar …`:

```bash
npm i -D @nonameolsson/nightjar
```

Whichever you pick, commit `factory.json` and add `.factory/` to `.gitignore`.

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
- the **check command**: it offers what the repo names (a `Makefile` or `justfile` target, a `package.json` script run by the package manager its lockfile names, `pyproject.toml`, `Cargo.toml`, `go.mod`, `mise.toml`, `deno.json`, a workflow under `.github/workflows/`, a `*.test.sh`), as a numbered list when there are several, and asks for one when it finds none. It warns about a check that can never fail, such as `true`;
- the commands the Coding agent may run, which it offers as the check command and the test, lint and build commands it found.

Each question prints a line of help, and `?` prints more. Before it writes, `init` shows the `factory.json` it will write, the Signal labels it will create and the logins it will check, and asks to go on; on no it writes nothing. Then it writes `factory.json` (below), which you commit, names the optional settings it left out, and:

- **on GitHub** creates the Signal labels (`factory-go`, `ready-for-agent`, `agent-working`, `needs-info`, `ready-for-human`, or the names `factory.json` gives them), leaving any that exist as they are;
- **on Azure DevOps** says tags appear on first use, so there is nothing to create;
- checks every login it needs and says how to fix each one that is missing: `gh auth login`, `az login` or a token in `AZURE_DEVOPS_EXT_PAT`, and `claude auth login`;
- runs the check once on this checkout and says whether it passes: one that fails now will stop every Ticket.

It ends with the next step, run `nightjar doctor`, then assign a Feature to yourself and give it the Go, and offers to run `doctor` straight away.

It reads its answers from standard input, line by line, so a script can pipe them in; there is no need for a terminal. A script or an agent can instead give the answers as flags, and `--yes` takes every default and asks nothing:

```bash
nightjar init --yes --check 'make check'
nightjar init --yes --check 'make check' --tracker azure-devops --tracker-organization contoso \
  --tracker-project Fabrikam --code-host-repo fabrikam-app
```

Each answer has its flag: `--check`, `--allowed-commands` (comma separated, or `none`), `--tracker` and `--code-host` (the type), and a field of either, as `--tracker-` or `--code-host-` then the field: `repo`, `organization`, `project`, `path`, and on the Tracker `feature-type` and `ticket-type`. Under `--yes`, a value with no default and no flag stops `init` before it writes anything, naming the flag to pass. If `factory.json` is already there, `init` keeps it, asks nothing, runs no check, and only creates the labels and checks the logins: run it that way after you have fixed a login, or when you join a repo that has one.

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
| `codeHost`        | yes      | `{ "type": "github" }`: the branch is pushed to `origin` and a draft pull request opened. `repo` as above. Or `{ "type": "azure-devops" }` with `organization`, `project` and `repo`, the Git repo on Azure Repos the branch is pushed to and the draft pull request opened on. Or a `module`, as for `tracker`. On GitHub, the optional `trustedChecks` lists the slugs of the GitHub Apps (`["lint-bot"]`) whose failed checks on the pull request count as feedback for the agent; GitHub Actions always counts, and a failed check from any other app is left out. |
| <a id="factory-check"></a>`check` | yes      | The shell command that checks the work in the worktree, run after each Ticket. A non-zero exit means it failed. Nightjar assumes no language or toolchain, so there is no default.                                  |
| `allowedCommands` | yes      | What the agent may run, as Claude Code Bash permission patterns without `Bash( )`, such as `make test` or `make lint *`. Committing, pushing, switching branches, the network and `gh` stay denied whatever you list. The list may be empty. |
| `gate`            | no       | What the report on a red `check` holds, given to the fix rounds and the pull request: the red stages, every failing test once from the whole output, and the last 40 lines without colour codes. `failingTest` is a regular expression whose first group names a failing test (default: a `FAIL name` line). `ignore` matches lines to drop, such as notes about slow tests. `stages` is for a check split into stages: `red` is a regular expression whose first group names a red stage, and `log`, optional, is where a stage leaves its whole log, relative to the worktree, with `{stage}` for its name (`.cache/{stage}.log`); its failing tests join the report. Left out, a red check still gets its failing tests and its plain tail. |
| `signals`         | no       | The name each Signal has on the Tracker (a label on GitHub, a tag on Azure DevOps). Leave out the ones you do not rename. Defaults are shown above. `needs-triage` and `wontfix` are refused: Nightjar never reads or sets them.          |
| `trusted`         | no       | The logins whose comments reach the agent (on Azure DevOps, sign-in names such as `ann@contoso.com`, in any case). Replaces the default: on GitHub anyone with write access, on Azure DevOps the members of the project's Contributors group.                                                                                                      |
| `setup`           | no       | A shell command run once in each new worktree before the first session, such as an install. If it fails, the Feature stops with a comment saying why.                                                              |
| `ports`           | no       | Reserve `count` (1 to 100) ports per run, held until the process ends so two runs never share one. `env` names the variables that carry them: the first name gets the first port, the next name the next, and so on. At most `count` names. |
| `plugins`         | no       | Plugin directories, relative to the repo root, loaded by every session (`claude --plugin-dir`). A restricted session ignores the repo's own `.claude/skills`, so a skill a Workflow Step names as `/skill` must come from one: `[".claude"]` loads the skills committed there, which `doctor` then sees as `.claude:<skill>`. |
| `rules`           | no       | A text file, relative to the repo root, added to the agent's prompt. Conventions normally live in `CLAUDE.md` or `AGENTS.md`.                                                                                       |
| `model`, `effort` | no       | The default model and effort of every session.                                                                                                                                                                      |
| `review`          | no       | The read-only review of the whole diff, run before the draft pull request opens. `enabled: false` switches it off (on by default); `model` and `effort` are the review's own, else the defaults above.            |
| `pullChecks`      | no       | `enabled: true` has `--watch` fix the failed Pull checks of Nightjar's own draft pull requests before it takes the next Feature: one Session resumes the head commit's, the repo's check must be green, and the fix is pushed as a new commit. A pull request a person reviewed, commented on or pushed to is left alone. Off by default, and over a Code host that cannot list its drafts. `fixRounds` (1 to 10, default 2) is how many fix rounds one pull request gets, counted from its branch's `Factory-Pull-Fix` trailers; `fixUsd` (default 5) and `fixMinutes` (default 30) cap each round, its check's fix rounds too. A round that gives up, or a pull request red again after its rounds, gets the Feature `ready-for-human` and a comment naming the failing Pull checks, and the pass leaves it alone from then on. Each round, a given-up one too, is added to a Pull checks section of the pull request body with its summary, failing checks and cost; the ledger and the live views show it as its own kind of work. |
| `workflows`, `defaultWorkflow` | no | Work the repo adds to the build loop: see [Workflows](#workflows). A Feature picks a Workflow with a `**Workflow:**` line; `defaultWorkflow` is the one a Feature without the line gets. Left out, a build runs no Step. |
| `sources`         | no       | What makes Features with nobody writing them, run by `nightjar intake`: see [Make Features from Sources](#make-features-from-sources). |

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
| `pollSeconds` | `120`               | How often `--watch` looks again when idle, at least `30`. `--poll` beats it. |
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

A Workflow can also have a `prompt`: text added to the build Session's instructions for each Ticket of a Feature that picks it. A Workflow with a `prompt` may have no Steps; one without a `prompt` builds as before.

**The `bug` Workflow.** Nightjar ships it in [`templates/workflows/bug.json`](templates/workflows/bug.json); copy it into `workflows` in `factory.json`. Its prompt tells the Session to reproduce the bug before fixing it: write a test that shows the problem, run it and see it fail, fix the code, see the test pass, keep the test, and name the test in its final answer. The draft pull request then has a "Test that shows the bug" section naming it.

```json
{
	"workflows": {
		"bug": {
			"prompt": "This Ticket is a bug. Reproduce it with a test before you fix it:\n\n1. Write a test that shows the problem, in the repo's own test setup and beside the code it covers.\n2. Run it and see it fail, for the reason the Ticket describes. A test that fails for another reason, or passes, does not show the bug: change it until it does.\n3. Fix the code, not the test.\n4. Run the test again and see it pass.\n5. Keep the test in the change.\n6. In your final answer, set \"test\" to the file and name of the test that shows the bug, and say in the summary how you saw it fail and then pass."
		}
	}
}
```

A Feature picks it with `**Workflow:** bug`.

A Workflow can also have `output: "note"`, for work whose result is findings, not code. Each Ticket's Session may then write only under `docs/research/`: its settings allow Edit and Write there alone, and Bash only for git's read commands, as the repo's `allowedCommands` could write anywhere. The fixed deny rules stay as they are. A Session that writes no note is handed back as one that changed no file. Once the Feature is built, its draft pull request holds the note, and the Feature gets `ready-for-human` with a comment whose Next step is to read the note, then close the Feature or follow up. A note Workflow cannot have Steps, as a Step can edit code anywhere: `nightjar doctor` fails it, and a Feature that picks it is refused.

**The `exploration` Workflow.** Nightjar ships it in [`templates/workflows/exploration.json`](templates/workflows/exploration.json); copy it into `workflows` in `factory.json`. It has `output: "note"`, and its prompt asks for a note with the question, the findings, the sources they rest on and a recommendation, and no code change. A Feature picks it with `**Workflow:** exploration`.

A Workflow can also have `serve`, a command started in the background in the worktree before its Steps and stopped after them (it reads its port from the variables of `ports.env`, so `ports` is required); `allowedCommands` and `allowedTools`, which its Steps may use besides the usual ones; and `localNetwork`, which lets its Steps reach localhost and nothing else. The fixed deny rules (committing, pushing, switching branches, the outside network, `gh`) cannot be loosened by any of these.

Steps share one notes folder, `.factory/notes/` in the worktree, which is never committed. Nightjar passes nothing else from one Step to the next, so a Step that needs what an earlier one found reads it there.

What a Step changes goes through the check command and its fix rounds, then is committed on its own, with a message naming the Workflow and the Step. Steps count against the daily spend limit and show in the cost of the pull request. A Step that hits its budget or time limit, cannot get the check green, answers in a shape not known, or reports itself blocked has its changes thrown away; the later Steps still run, and the pull request opens with that Step listed as not done. A Step the branch already holds is not run again when a later run goes on.

`nightjar doctor` looks up each `/skill` a Step's prompt names among the skills a headless Claude session loads. A skill that is missing is an error for that Workflow only: a Feature that picks it stops with a comment, and the others build as usual. (A word like `/tmp/notes` is a path, not a skill; a bare `/word` in a prompt is read as one.)

### A scan that must pass

A Step cannot stop a Feature. A Step that fails or reports itself blocked is listed as not done, and the draft pull request still opens. So a security or policy scan that must hold a Feature does not belong in a Step.

Put it in the [`check` command](#factory-check) instead, after the tests:

```json
{
	"check": "npm test && npm audit --audit-level=high"
}
```

A finding then fails the check like a failing test does. The usual fix rounds work on it, and a check that stays red after them stops the run: the Tickets after it wait, the draft pull request opens, and the Feature gets the needs info Signal with a comment naming the Ticket after which the check fails. A Step's changes go through the same check, so a Step cannot bring in a finding either.

Nightjar runs the check itself, not as the Coding agent, so the agent's deny rules do not hold it: a scanner there may reach the network to fetch its rules or advisories, which the agent's own commands may not.

A Step whose prompt runs a review skill, such as a security review, is advisory. The pull request's Workflow section lists it as done or not done and, with an `until`, what is left; a person reads that, and the Feature is not held.

## Onboard a repo and its existing issues

Nightjar ignores every issue until a person promotes it. A Feature is built only when it is assigned to you and carries the Go; a Ticket only when it carries the ready Signal. Issues that were there before Nightjar, and issues an agent filed without knowing Nightjar, are never built by accident.

To start on a repo:

1. Run `nightjar init`, commit `factory.json`, and add `.factory/` to `.gitignore` ([Set up](#set-up-nightjar-init)).
2. Run `nightjar doctor` and fix each `FAIL`.
3. Pick the few issues worth automating. Leave the rest alone.
4. Turn each pick into a Feature with Tickets that meet the [Ticket contract](#the-ticket-contract). An old issue rarely does: it has no acceptance criteria and no blocking links. Write it as a Feature file, link the old issue from the spec, and make it with `nightjar create --dry-run FILE`, then `nightjar create FILE` ([Write a Feature](#write-a-feature)). The `nightjar-feature` skill can start from the old issue's references: it reads each issue and its comments, writes `Replaces <reference>.` into the spec, and after `nightjar create` offers to comment on the old issue and close it as not planned. Close the old issue once the Feature carries its work.
5. Run `nightjar doctor FEATURE` before the Go. It prints each open Ticket as `ok` or with what it lacks (an `Acceptance criteria` checklist, a value on each `Model` and `Effort` line), changes nothing on the Tracker, and exits 1 when any Ticket fails. It also says what sits across the Tickets: an open blocker outside the Feature, a blocking loop, an open Ticket without the ready Signal, no open Ticket, a `**Workflow:**` line no Workflow answers to. Link the blockers and put the ready Signal on each Ticket yourself.
6. Assign the Feature to yourself and add the Go ([Give the Go](#give-the-go)).

Never let an agent that does not know Nightjar add the Signal labels. If an agent files issues in this repo, have it write a Feature file and run `nightjar create` instead, or copy the `nightjar-feature` skill into the repo for it to use.

## See your Features in a GitHub Project

The issues list is flat: a Feature and its Tickets look the same. A GitHub Project (v2) shows the hierarchy. Create one from your profile or organization, link it to the repo, and add the repo's issues. Then make three table views:

| View             | Filter                                 | Setup                                                                                  |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| Features         | `no:parent-issue`                      | Show **Sub-issues progress** and **Labels**. A Feature's arrow opens its Tickets.      |
| Tickets          | none                                   | Group by **Parent issue**: each Feature heads its Tickets, with a progress bar.        |
| Waiting on you   | `label:needs-info,ready-for-human`     | Empty while nothing waits. These are the issues that need a person.                    |

Show a column with the **+** at the right of the headers. A view change is saved only after **View → Save changes**.

A Board's columns come from a single-select field such as Status, never from labels, and the Signals are labels. So Nightjar does not feed a Board; use `nightjar ui` for that. Which labels a Feature and its Tickets carry at each point of a build is in [Signals through a build](docs/ticket-contract.md#signals-through-a-build): a built Ticket, for one, keeps `ready-for-agent` until its pull request merges.

Since June 2026, repository **saved views** (the Issues sidebar) keep a filter shared with everyone who has triage access. They are plain queries and show a flat list. Use them for the Signal filters, for example Queued: `is:open label:factory-go -label:agent-working`; the Project is what shows the hierarchy.

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

## Make Features from Sources

Some work starts outside a person's head: an alert, a message from a script or from a tool such as Zapier or n8n. A **Source** makes a Feature from such an event with nobody writing it, from a template. Sources live under `sources` in `factory.json`:

```json
"sources": {
	"alerts": {
		"type": "webhook",
		"template": ".nightjar/alerts.md",
		"key": "data.alert.id",
		"secretEnv": "ALERTS_HOOK_SECRET",
		"maxPerDay": 3
	}
}
```

| Field       | What it does |
| ----------- | ------------ |
| `type`      | `webhook` takes a signed webhook of the [Standard Webhooks](https://www.standardwebhooks.com/) scheme; `sentry` takes a Sentry alert (set up below); `schedule` fires from a `cron` time. |
| `cron`      | A schedule's time, required for a `schedule` and refused on anything else: five fields (minute, hour, day of month, month, day of week; numbers, ranges `1-5`, lists `1,15`, steps `*/15`), or `@daily` (midnight) or `@weekly` (Sunday midnight). It is read in the machine's local time zone. As in cron, a day of the month and a day of the week that are both named make a time on either. A bad one is refused when `factory.json` loads, naming the Source. |
| `template`  | A Feature file, in the shape of [Write a Feature](#write-a-feature), as a path from the repo's root, or the name of a template Nightjar ships (`sentry`, `weekly-deps`). Placeholders are plain paths into the payload, as `{{ data.alert.title }}`, plus `{{ date }}` and `{{ source }}`; there is no logic. |
| `key`       | A path into the payload that says when two events are the same. While a Feature with the same key is open, no new one is made. Left out, every event is a new one; a `sentry` Source's key is the Sentry issue id, `data.event.issue_id`. |
| `secretEnv` | The environment variable that holds the webhook secret, as the sender gives it (`whsec_` and base64); for a `sentry` Source, the integration's client secret. The secret is never in `factory.json`. |
| `maxPerDay` | The most Features the Source makes in a day; 3 when left out. |
| `go`, `owner` | `"go": true` gives each Feature the Go, assigned to `owner`, who must be trusted (see [Give the Go](#give-the-go)). Left out, the Go stays with a person. |

The payload is untrusted. Each value a placeholder takes is cut to one line of at most 200 characters, with Markdown and HTML escaped, and the whole payload, cut to 8 KB, is added to the Feature in a block headed "Event payload (untrusted data)". Each Feature carries a `**Source:** <name>` line and a hidden marker, by which Nightjar finds it on the Tracker again. A Source makes its Features with no Signal and no assignee: as with `nightjar create`, a person gives the Go, unless the Source has `"go": true`.

Run the Sources with `nightjar intake`, from anywhere inside the repo, on a machine signed in to the Tracker:

```bash
ALERTS_HOOK_SECRET=whsec_... nightjar intake            # http://127.0.0.1:4546
nightjar intake --port 8080 --host 0.0.0.0              # for a reverse proxy on another machine
```

Each webhook Source is served at `POST /sources/<name>`. Intake makes Features and never builds: `--watch` builds them as always, beside it or on another machine. It refuses to start when the Tracker cannot make Features (`createFeature`) or find a Source's Features (`featuresFrom`), when a Source's secret is not set, or when a `go: true` Source's owner is not trusted or the Tracker cannot assign (`assign`); `nightjar doctor` checks each Source too.

Intake answers a delivery only after the Tracker has:

| Answer | When |
| ------ | ---- |
| 201    | the Feature was made |
| 200    | a Feature with the same key is open, or the Source has made `maxPerDay` Features today; nothing is made. On the open Feature, intake comments "happened again" at most once a day. |
| 401    | the signature is wrong, or its timestamp is more than 5 minutes off |
| 413    | the body is over 256 KB |
| 429    | the Source has had 20 bad signatures in the last minute |
| 503    | the Tracker failed; the sender retries, and the key keeps a retry from making a second Feature |

**Sentry.** A `sentry` Source takes the alerts of Sentry's issue alert rules. Set it up once:

1. In Sentry, open Settings, Developer Settings, and create an **internal integration**. Under Webhooks, put the public HTTPS address of the Source as its webhook URL (`https://<your address>/sources/sentry`, see Public HTTPS below), and tick **alert rule action**. Give it the permission Read for Issue & Event. Save it, and copy its **Client Secret**.
2. Put the client secret in the variable the Source names as `secretEnv`, where intake runs: `SENTRY_HOOK_SECRET=... nightjar intake`.
3. In the project's **Alerts**, make an issue alert rule (or edit one), and under actions pick **Send a notification via** your integration. The rule decides which errors reach Nightjar: filter by environment, level or frequency there, as Nightjar takes every alert the rule sends.

```json
"sources": {
	"sentry": { "type": "sentry", "template": "sentry", "secretEnv": "SENTRY_HOOK_SECRET" }
}
```

Intake checks `Sentry-Hook-Signature`, the HMAC SHA-256 of the raw body with the client secret, and answers 401 when it is wrong. It takes `event_alert` deliveries only (the `triggered` alert): a delivery of any other `Sentry-Hook-Resource` that Sentry sends to the same URL gets 200 and makes nothing. The key is the Sentry issue id, so while the Feature of an issue is open, a new alert for it makes no second Feature and only comments "happened again", at most once a day. The shipped `sentry` template fills the Feature from the alert (`data.event.title`, `culprit`, `level`, `web_url` and `data.triggered_rule`) with one Ticket: reproduce the error in a spec, then fix it so the spec passes.

**Shipped templates.** Name one in a Source's `template`. `sentry` is the one above. `weekly-deps` has one Ticket, to update the dependencies the repo's check command still passes with, and goes with a schedule:

```json
"weekly-deps": { "type": "schedule", "cron": "0 6 * * 1", "template": "weekly-deps" }
```

**Schedules.** Intake fires each `schedule` Source at its due time, through the same path as a webhook, from the template with no payload. The Source's name is its key, so a schedule whose last Feature is still open makes nothing, and says nothing on it. `maxPerDay` holds as for a webhook. Times that pass while intake is down are not made up, and a machine that sleeps through several makes one Feature when it wakes, not one for each. Only `nightjar intake` fires schedules, never `--watch`. A schedule needs no secret, so intake with schedules only starts and serves nothing. `nightjar doctor` prints each schedule's next due time, and intake prints it as it starts.

The open Features and the day's count are read from the Tracker, so two intakes on two machines share them. Each delivery is logged to `.factory/intake.log` with the Source, the delivery id, the answer and the Feature, never with the payload.

**Public HTTPS.** Intake listens on 127.0.0.1 and speaks plain HTTP. A sender on the internet needs a public HTTPS address: put a tunnel (such as Cloudflare Tunnel or ngrok) or a reverse proxy (such as Caddy or nginx) in front of it, pointed at `http://127.0.0.1:4546`. Use `--host` only when the proxy runs on another machine, and never expose the port without TLS in front of it.

**Deliveries while intake is down are lost**, unless the sender retries them. Run intake on a machine that stays on, under a service manager such as systemd or launchd, and pick a sender that retries a failed delivery.

## The Ticket contract

Every Ticket holds acceptance criteria (a checklist under an `Acceptance criteria` heading), optional blocking links to the Tickets that must be done first, and optional `**Model:**` and `**Effort:**` lines. The full contract, which holds on any Tracker, is in [docs/ticket-contract.md](docs/ticket-contract.md); the package ships it. A Feature with no Tickets is its own Ticket, so its body holds them.

## Give the Go

Nightjar builds a Feature that is **assigned to you** and carries the **Go** Signal (the label `factory-go` by default). Nothing else starts a build. A person gives the Go, with one exception: a [Source](#make-features-from-sources) with `"go": true`, below.

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

**A Feature without Tickets is its own Ticket.** When a Feature has no Tickets, the build makes one Ticket of the Feature itself, with the Feature's body as the Ticket's body, and builds it as one commit. So the body holds an `Acceptance criteria` checklist, and may hold the `**Model:**` and `**Effort:**` lines; without the checklist the Feature gets needs info and a comment saying so, with no Session. A Feature with Tickets is built as above, from its Tickets alone. `nightjar doctor FEATURE` reports a Feature without Tickets as `ok` when its body holds the checklist.

**A standing Go from a Source.** A Source with `"go": true` and an `owner` gives each Feature it makes the Go: intake assigns the Feature to the owner, then adds the Go, and the owner's `--watch` builds it. This is the one place Nightjar gives the Go. Whoever commits such a Source to `factory.json` gives a standing Go, ahead of time, to every Feature it makes ([ADR 0003](docs/adr/0003-a-source-may-give-a-standing-go.md)). It is bounded by the Source's `maxPerDay`, the [limits](#limits) of each Ticket, and the owner's own `dailyUsd`.

```json
"weekly-deps": { "type": "schedule", "cron": "0 6 * * 1", "template": "weekly-deps", "go": true, "owner": "ann" }
```

The owner must be trusted: on `factory.json`'s `trusted` list, or if there is no list, by the Tracker's own default, write access on GitHub or the project's Contributors group on Azure DevOps Boards. `nightjar intake` refuses to start, and `nightjar doctor` fails the Source, while the owner is not trusted, or while the Tracker has no `assign` (a [Tracker module](docs/custom-adapters.md) written before it). If assigning a Feature fails, intake still answers 201 and leaves the Feature with no Signal, for a person to give the Go.

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
| `doctor FEATURE`       | Checks that Feature's open Tickets against the Ticket contract, with no machine check, and prints one line per Ticket: `ok` or each fault. Also reports faults across the Tickets (see [the Ticket contract](docs/ticket-contract.md)). Writes nothing to the Tracker; exits 1 when any fails. |
| `--once`               | Builds the oldest Feature assigned to you with the Go, then exits.                                     |
| `--watch`              | Builds the Features assigned to you with the Go, oldest first, and looks again every 2 minutes, or `pollSeconds`. |
| `--poll SECONDS`       | With `--watch` only: looks again after this many seconds (at least 30); beats `pollSeconds`.           |
| `<id>`                 | Builds that Feature now, by its id on the Tracker (`nightjar 42`, `#42`, or `nightjar PROJ-123` from a Tracker module). It refuses a Feature not assigned to you, without the Go, or already carrying the working Signal. |
| `--use-api-key`        | Lets the sessions bill `ANTHROPIC_API_KEY` instead of your Claude plan.                                |
| `--profile <name>`     | Runs the sessions as that Claude login: `~/.claude-NAME`, a path as the folder itself, or `default` for `~/.claude`. It drops `CLAUDE_CODE_OAUTH_TOKEN`, which would win over the folder. `doctor` and every build name the account, organization, plan and config folder first. |
| `--model <model>`      | The model of every session, over a Ticket's own line and `factory.json`.                               |
| `--effort <level>`     | The effort of every session, over a Ticket's own line and `factory.json`.                              |

Pick exactly one of `doctor`, `--once`, `--watch` or a Feature id. `--use-api-key`, `--profile`, `--model` and `--effort` combine with any of them; `--poll` only with `--watch`. `nightjar create [--dry-run] FILE` makes a Feature from a file ([Write a Feature](#write-a-feature)), and `nightjar contract MODULE` checks an Adapter module. `nightjar ui [--port PORT]` serves a read-only page about the repo's builds on 127.0.0.1 (default port 4545), read from `.factory/` alone. `nightjar intake [--port PORT] [--host HOST]` runs the Sources ([Make Features from Sources](#make-features-from-sources)).

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
