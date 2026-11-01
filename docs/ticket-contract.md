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

A Ticket is built only while it carries the ready Signal (`ready-for-agent` by default). Its Feature carries no Signal until a person assigns it to themselves and gives it the Go (`factory-go` by default).

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

`nightjar create --dry-run FILE` reads the file and says what it would make, making nothing. A file out of this shape is refused before anything is made, with every fault and its line.

`nightjar create` then makes, in order: the Feature, with no Signal; each Ticket as its last child, linked to its blockers and then given the ready Signal. It prints each with the Tracker's reference (`#12`, `AB#12`). If the Tracker fails part way, it names what it made before the fault and undoes nothing. It never assigns the Feature and never gives the Go: that stays with a person.

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
