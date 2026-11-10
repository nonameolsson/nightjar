# The Ticket contract

What a Ticket must hold for Nightjar to build it, on any Tracker, and the Feature file that `nightjar create` turns into a Feature and its Tickets. The words are defined in [GLOSSARY.md](../GLOSSARY.md).

## A Ticket

A Ticket is one child of a Feature, built as one commit. It holds:

- **Acceptance criteria**, in its body: a heading named `Acceptance criteria` with a checklist under it. The Coding agent builds to them and the review reads the diff against them.

  ```markdown
  ### Acceptance criteria

  - [ ] comments escape through src/escape.ts
  - [ ] a comment with <b> shows it as text
  ```

- **Blocking links**, on the Tracker: the Tickets that must be closed, or already built on the Feature's branch, before this one is built. On GitHub these are **blocked by** links; on Azure DevOps Boards, **Predecessor** links. Tickets are built in that order, then in the Feature's own child order (the Build order). On Azure DevOps Boards the child order is the backlog rank (Stack Rank or Backlog Priority), and for children nobody has ranked, the order they were linked; so the Build order there is Predecessor links, then backlog rank, then child-link order.
- Optionally, a **`**Model:**`** and an **`**Effort:**`** line, anywhere in its body, each on a line of its own:

  ```markdown
  **Model:** opus
  **Effort:** high
  ```

  The first word after the colon is read, in any case; the bold is optional. A Ticket without them runs on `model` and `effort` from `factory.json`; `--model` and `--effort` on the command line win over both.

A **lone issue** is an issue assigned to you with the Go and no sub-issues, open or closed. Its body is both the spec and the Ticket, so it must hold what a Ticket holds: acceptance criteria, optional blocking links, and optional `**Model:**`, `**Effort:**` and `**Workflow:**` lines. It needs no ready Signal. It is never built alone while it is a sub-issue of a Feature, because that Feature owns it. A Feature whose sub-issues are all closed is not a lone issue and builds nothing.

A Ticket is built only while it carries the ready Signal (`ready-for-agent` by default). Its Feature carries no Signal until a person assigns it to themselves and gives it the Go (`factory-go` by default). The one exception is a Source with `"go": true` in `factory.json`: intake assigns each Feature it makes to the Source's trusted `owner` and gives it the Go, a standing Go from whoever committed that Source ([docs/adr/0003](adr/0003-a-source-may-give-a-standing-go.md)).

## Signals through a build

Which Signal each item carries, and when it changes, under the default names:

| When                                                             | The Feature                                         | Each Ticket                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `nightjar create` makes it                                       | none                                                | `ready-for-agent`                                            |
| A person assigns the Feature and gives the Go                    | `factory-go` on                                     | no change                                                    |
| A Source with `"go": true` makes it (instead of the two rows above) | none, then assigned to the owner and `factory-go` on | `ready-for-agent`                                       |
| Nightjar claims it                                               | `agent-working` on, `factory-go` off                | no change                                                    |
| A Ticket is being built                                          | no change                                           | `agent-working` on, beside `ready-for-agent`, from just before its Session starts |
| A Ticket is built (its commit lands, even when the check is red) | no change                                           | `agent-working` off once its commit and `afterEachTicket` Steps are done; keeps `ready-for-agent`; the branch's `Factory-Ticket` trailer is the only record, and the Ticket closes when the pull request merges |
| A Ticket is handed back (its Session failed, it asked questions, it changed no file) | no change                       | `agent-working` off, `ready-for-agent` off, `needs-info` on; `ready-for-human` instead once its question rounds run out |
| The run pauses (the daily limit, the plan's usage limit)         | `factory-go` back on, `agent-working` off           | `agent-working` off                                          |
| A person stops the run                                           | `agent-working` off                                 | `agent-working` off                                          |
| The run ends with a draft pull request                           | `agent-working` off; `needs-info` on while a Ticket waits or the check is red | no change                          |
| The run builds nothing, its Workflow is refused, its setup fails, or a fault stops it | `agent-working` off, `needs-info` on | no change                                               |
| The Pull-check pass fixes its red draft pull request (`pullChecks.enabled`) | `agent-working` on for the round, then off | no change                                            |
| A Pull-check fix round gives up: the check stays red, the Session gives up, or the round runs over `fixUsd` or `fixMinutes` | `ready-for-human` on, with a comment naming the pull request and each failing Pull check | no change |
| The pull request is red again after `fixRounds` Pull-check fix rounds | `ready-for-human` on, with the same comment; no Session runs | no change                  |
| A person takes `ready-for-human` off after the pass handed the Feature over | no change: the pass leaves the pull request alone, and the rounds it had still count | no change |

The pass counts a pull request's rounds from the `Factory-Pull-Fix` trailers on its branch, so neither a new run nor taking `ready-for-human` off resets them. Once it hands a Feature to a person it marks the pull request's body, and leaves the pull request alone from then on; the Go runs a normal build on the branch, which writes the body afresh.

Nightjar never takes `needs-info` or `ready-for-human` off: the person does, and gives the Go again. It never sets a tracker state or a GitHub Project's Status field ([docs/adr/0002](adr/0002-signals-are-labels-or-tags-never-states.md)).

Every comment Nightjar leaves for a person ends with a **Next step**: what to answer, which Signal to take off and put on, and the Go to give again, by the names `factory.json` sets (`src/next-step.ts`).

## A Feature's Workflow

A Feature may carry a **`**Workflow:**`** line anywhere in its body, on a line of its own, to add the Steps of a Workflow from `factory.json` to its build:

```markdown
**Workflow:** design-review
```

The rest of the line is the Workflow's name. Without the line the Feature gets the repo's `defaultWorkflow`, if it has one; a name no Workflow has marks the Feature as needing info. See the README's Workflows section.

## The Feature file

`nightjar create FILE` makes a Feature and its Tickets on the Tracker `factory.json` names, from one Markdown file:

```markdown
# Share one HTML escape

The spec: the problem, the solution, the decisions. Any Markdown, headings included.

## Ticket 1: Move the escape into one module

**Model:** opus
**Effort:** high

What to build.

### Acceptance criteria

- [ ] one module exports escapeHtml

## Ticket 2: Use it in the comment renderer

**Blocked by:** 1

What to build.

### Acceptance criteria

- [ ] comments escape through it
```

- The first line is `# ` and the Feature's title. Everything up to the first Ticket is the Feature's body.
- Each Ticket starts with `## Ticket N: Title`, numbered 1, 2, 3 in the order they are to be built. A `## Ticket` line inside a fenced code block is text.
- `**Blocked by:** 1, 2` names Tickets above it by number. It becomes blocking links on the Tracker and leaves the body; a Ticket can only wait for Tickets above it, so the links never form a loop. Leave the line out, or write `none`, for a Ticket that waits for nothing.
- Every Ticket has acceptance criteria. `**Model:**` and `**Effort:**` lines, when there, have a value, and stay in the body as written.

A Ticket on the Tracker is held to the same contract before its Session. One without acceptance criteria, or with a `**Model:**` or `**Effort:**` line with no value, is handed back with no Session and no spend: the ready Signal comes off, needs info goes on, and a comment lists each fault. Nightjar never edits the issue.

`nightjar doctor FEATURE` checks a Feature's open Tickets against that contract, and also what sits across the Feature's Tickets, which the build does not check before a Session. Each is a fault, and any fault makes it exit 1:

- an open blocker that is not one of the Feature's Tickets (a closed blocker, or one among the Feature's Tickets, is no fault), since a build never reaches it;
- a blocking loop between Tickets, named by each Ticket in it, since none of them is built;
- an open Ticket without the ready Signal, since a build skips it;
- a Feature with no open Tickets, since a build has nothing to do;
- a `**Workflow:**` line naming a Workflow `factory.json` does not have.

It reads only what every Tracker gives (the Feature, its Tickets and their blockers), and changes nothing.

`nightjar create --dry-run FILE` reads the file and says what it would make, making nothing. A file out of this shape is refused before anything is made, with every fault and its line.

`nightjar create` then makes, in order: the Feature, with no Signal; each Ticket as its last child, linked to its blockers and then given the ready Signal. It prints each with the Tracker's reference (`#12`, `AB#12`). If the Tracker fails part way, it names what it made before the fault and undoes nothing. It never assigns the Feature and never gives the Go: that stays with a person. Only a Source with `"go": true`, which makes its Features the same way, then assigns each to its owner and gives the Go.

| Tracker               | The Feature                    | Each Ticket                                       | Blocking links      |
| --------------------- | ------------------------------ | ------------------------------------------------- | ------------------- |
| GitHub Issues         | an issue                       | an issue, made a sub-issue of the Feature          | blocked by          |
| Azure DevOps Boards   | a work item of `featureType`   | a child work item of `ticketType`                 | Predecessor         |
| A module              | `createFeature`                | `createTicket`                                    | `block`             |

On Azure DevOps Boards, `factory.json` names the work item type of a Ticket as `tracker.ticketType` (such as `User Story`, `Product Backlog Item` or `Issue`); without it `nightjar create` refuses. Bodies are written as Markdown. A Tracker module makes Features when it has all three methods of `FeatureWriter` ([custom-adapters.md](custom-adapters.md)).

## The skill

The package ships a Claude Code skill, `nightjar-feature`, that writes a Feature file from an agreed idea and makes it with `nightjar create`. It needs no other skill. To use it in a repo:

```bash
mkdir -p .claude/skills
cp -R "$(npm root -g)/@nonameolsson/nightjar/skills/nightjar-feature" .claude/skills/
```
