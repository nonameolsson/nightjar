---
name: nightjar-feature
description: Write an agreed idea onto the repo's Tracker as a Nightjar Feature and its Tickets, through `nightjar create`. Use when a spec, plan or grilled idea is ready to become a Feature for Nightjar to build.
---

# Write a Feature and its Tickets

Turn the idea agreed in this conversation into one Feature file and make it on the Tracker with `nightjar create`. Nightjar builds each Ticket as one commit, in Build order, on one branch.

## 1. Read the repo's setup

Read `factory.json` at the repo's root. Note the Tracker, and on Azure DevOps whether `tracker.ticketType` is set: without it `nightjar create` refuses, so ask the person which work item type a Ticket is (such as `User Story`) and add it to `factory.json` before step 4. Read the repo's `CLAUDE.md` or `AGENTS.md` and its glossary, if any, so titles use the repo's own words.

Done when you know the Tracker and that it can make Tickets.

## 2. Slice the idea into Tickets

Each Ticket is a **vertical slice**: one change that builds, passes the repo's check command, and is worth a commit on its own. Order them so each one builds on the ones above it. Give each:

- a title that says what changes, in the imperative;
- what to build, enough for an agent with no other context: the files or modules it touches, the behaviour it adds;
- acceptance criteria an agent can check from the diff and the tests;
- the Tickets above it that must be built first;
- `**Model:**` and `**Effort:**` lines only for a Ticket that needs a stronger or a lighter model than the repo's default.

Done when every part of the agreed idea lands in exactly one Ticket, and every Ticket has acceptance criteria.

## 3. Write the Feature file

Write it to `.factory/plans/<short-name>.md`, in exactly this shape:

```markdown
# <Feature title>

<The spec: the problem, the solution, the decisions made, and what is out of scope.>

## Ticket 1: <title>

**Model:** opus
**Effort:** high

<What to build.>

### Acceptance criteria

- [ ] <a checkable result>

## Ticket 2: <title>

**Blocked by:** 1

<What to build.>

### Acceptance criteria

- [ ] <a checkable result>
```

Number the Tickets 1, 2, 3 in build order. `**Blocked by:**` names Tickets above it by number, comma separated.

## 4. Check it

Run `nightjar create --dry-run .factory/plans/<short-name>.md`. It names every fault with its line; fix them and run it again until it exits 0. Show the person what it says it would make.

Done when the dry run exits 0 and the person says to make it.

## 5. Make it

Run `nightjar create .factory/plans/<short-name>.md`. It makes the Feature with no Signal and each Ticket ready, linked to its blockers, and prints each reference.

If it exits 1, it names what it made before the fault: tell the person, and leave those items for them to keep or remove.

Report the Feature's reference and its Tickets'. The Go is the person's: tell them to assign the Feature to themselves and give it the Go when they want it built.
