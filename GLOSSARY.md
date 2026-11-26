# Nightjar

A command-line tool that builds a repo's Features with nobody at the keyboard: it reads Tickets from a Tracker, has a Coding agent build each one, and opens one draft pull request per Feature on a Code host.

## Language

### Work

**Feature**:
The tracker item that holds a spec and that a person gives the go to build. A role, not a tracker type: in Azure DevOps it may be a Feature, an Epic or a Product Backlog Item.
_Avoid_: parent issue, epic, story

**Lone issue**:
A tracker item with no sub-issues, open or closed, and no parent, that has the Go. It is built as a Feature of one Ticket, itself: its body is both the spec and the Ticket.
_Avoid_: single ticket, standalone issue

**Ticket**:
One buildable child of a Feature, built as one commit.
_Avoid_: sub-issue, task, story

**Ticket contract**:
What a Ticket must hold to be built: its blocking links and its acceptance criteria, and optionally Model and Effort lines that override the repo's defaults.
_Avoid_: ticket format, template

**Build order**:
The order a Feature's Tickets are built in: their blocking links, then the Feature's own child order.
_Avoid_: dependency graph, queue

**Queue**:
The Features assigned to a person with the Go, oldest first, that Nightjar builds as many at once as the run has Slots.
_Avoid_: backlog, next up

**Shelf**:
The open Features assigned to a person that carry no Signal yet: work they could give the Go. An item with no Tickets sits there as a Lone issue would be built.
_Avoid_: backlog, drafts, upcoming, icebox

**Slot**:
One of a run's places for work on one Feature at a time: its build, a Pull-check fix, a Conflict fix or a Feedback round. A run has as many as the person sets, one unless they say more, and a Feature is never in two at once.
_Avoid_: lane, worker, runner, thread

### Workflows

**Workflow**:
A named list of Steps that a repo adds to Nightjar's fixed build loop, chosen per Feature. It may also add a prompt to each Ticket's Session, and make the Feature's output a note under `docs/research/` in place of code (`output: "note"`); it never loosens the deny rules.
_Avoid_: Flow, pipeline, process

**Step**:
One instruction in a Workflow, given to the Coding agent at a fixed point in a build: after each Ticket, or after all Tickets.
_Avoid_: Stage, phase, hook, task

**Source**:
A named thing in `factory.json` that makes Features with nobody writing them, from a template: a schedule, a signed webhook, or a `botPulls` Source, which reads a dependency bot's red pull requests at a cron time and makes a Feature for each, built on the bot's branch (its `**Base:**` line). `nightjar intake` runs it; it builds nothing, and makes no Signal unless it has `"go": true`, which gives each Feature a standing Go in its owner's name. Each Feature it makes carries a visible `**Source:**` line and a hidden marker, by which the Tracker finds it again.
_Avoid_: trigger, automation, integration, hook, feed

### Steering

**Signal**:
One of a fixed set of marks a person or Nightjar puts on a Feature or Ticket to steer a build: the Go, ready, working, needs info, needs a person. Each Tracker shows a Signal in its own way (a label, a tag), under a name the repo configures, and never as a tracker state.
_Avoid_: label, tag, status (when the generic mark is meant)

**Go**:
The Signal by which a person tells Nightjar to build a Feature assigned to them. Its own mark, never shared with a triage role. Nightjar gives it in one place only: a Source with `"go": true` gives it to each Feature it makes, in the name of the trusted owner whose commit put that Source in `factory.json` (docs/adr/0003).
_Avoid_: ready-for-agent (on a Feature), start, trigger

**Trusted comment**:
A comment on a Feature or Ticket whose author Nightjar trusts, so it reaches the Coding agent. No other comment does.
_Avoid_: approved comment

**Status note**:
The one comment Nightjar keeps on a Feature and rewrites as its build goes on: its state, a headline, its Tickets, its pull request and the Next step. It never notifies anyone; a person who is needed is told by a new comment.
_Avoid_: tracking comment, sticky comment, progress comment

### The page

**Mat**:
One state's lane on the `nightjar ui` Board (Waiting on you, Building, Queue, Shelf, Completed), with a label tab and a tally of its Features.
_Avoid_: column, swimlane

**Egg**:
One Ticket's mark on the Board: built, building, needs a person, or waiting. It rests in a round nest socket in its Feature's row.
_Avoid_: dot, pip, bar

**Steps bar**:
A row of segments beside a Feature's Eggs, on its Board card and its Table row: one per stage of its latest build, in the loop's order (Tickets, Steps, Review, Review rounds, Pull checks, Feedback), each marked passed, passed after a retry or a round, failed, running, not reached or not needed. It is read from the ledger lines of that build, so a hard build shows without opening it.
_Avoid_: pipeline, progress bar, timeline, stepper

### Where things are

**Tracker**:
The system that holds Features, Tickets, Signals and comments, such as GitHub Issues or Azure DevOps Boards.
_Avoid_: board, backlog, issue system

**Code host**:
The system the Feature's branch is pushed to and its draft pull request opened on, such as GitHub or Azure Repos. Set independently of the Tracker.
_Avoid_: repo host, forge, remote

**Pull checks**:
The checks the Code host runs on a draft pull request's head commit, in its own environment, apart from the repo's check. They can fail where the repo's check passed.
_Avoid_: CI, pipeline, status, build

**Pull-check fix**:
A Session that fixes the failed Pull checks on Nightjar's own draft pull request, resuming the Session of its head commit, landed as one commit. It runs under `--watch` where the repo turns it on, a set number of times, and stops for good once a person engages.
_Avoid_: CI fix, autofix, red fix

**Conflict fix**:
A Session that resolves the merge conflicts between Nightjar's own draft pull request and its base, after Nightjar merges the base into the Feature's branch, landed as one merge commit. It runs under `--watch` where the repo turns it on, before a Pull-check fix, and stops for good once a person engages. A branch that is only behind its base gets none.
_Avoid_: rebase, sync, update branch, merge fix

**Feedback**:
What a person or a check said on a Feature's draft pull request that Nightjar may answer: a review comment, on a line or in the conversation, a review with a body, or a failed check on the head commit. Its id carries its kind (`comment:123`, `review:45`, `check:678`). Feedback from an author Nightjar does not trust never reaches the Coding agent, and Nightjar's own words, which end with its footer, are never feedback. It is answered once a `Factory-Feedback` trailer on the branch names it.
_Avoid_: review notes, PR comments, change requests

**Feedback round**:
A Session that answers the unanswered trusted Feedback on a Feature's open draft pull request, run before the review when the Feature gets the Go again, or under `--watch` and `--once` with no Go when a trusted reviewer requested changes since the branch's last `Factory-Feedback` commit. Such an automatic round's commit names the request in a `Factory-Feedback-Asked` trailer; a pull request gets 5 of them, and after that only a Go starts another round. It goes through the check and its fix rounds and lands as one commit whose `Factory-Feedback` trailer names the Feedback it answered, and Nightjar replies to each one with that commit. A round that fails is thrown away, and the Feature gets needs info.
_Avoid_: review round, PR fix, follow-up

**Preflight**:
The Session, before a Feature's first Ticket is built, that reads the Feature, its Tickets and the repo, changes no file, and says whether the Feature can be built in the sandbox: buildable, questions, or out of reach with a reason. Questions give the Feature needs info, and out of reach gives it needs a person. It is off unless the repo switches it on, runs again on each Go until it once says buildable, and when it gives no answer the build goes on.
_Avoid_: pre-check, feasibility check, triage, gate

**Review**:
The Session, after the last Ticket and the Steps, that reads the Feature's whole diff against its spec and the repo's rules and says approve or changes, with the issues it found. It is on unless the repo switches it off. Its findings are never Feedback.
_Avoid_: self-review, AI review, code review (when Nightjar's own is meant)

**Review thread**:
A thread on a line of the draft pull request that Nightjar starts for one issue of a Review. A person's reply in it is Feedback. A later build's Review resolves the earlier Review's threads, except one a person has replied in, which stays open until a person resolves it.
_Avoid_: review comment (that word is GitHub's), inline finding, annotation

**Review round**:
A Session that answers the Review's issues on a complete Feature before the draft pull request opens, after which the Review runs again. It may decline an issue with a reason, which the next Review sees. A build gets a set number of them; what the last Review still asks for is shown on the pull request, and the Feature gets needs a person.
_Avoid_: review fix, self-fix, second pass

**Publish**:
Nightjar taking its own draft pull request out of draft, where the repo lets it: once the Feature is complete, its last Review approves, its Pull checks are green and no person has engaged. Nightjar never turns a pull request back into a draft, and never merges one.
_Avoid_: ready, mark ready, undraft (ready is a Signal)

**Coding agent**:
The program that builds one Ticket in the Feature's worktree, in a Session Nightjar starts and ends; today only Claude Code. It edits files and runs the commands it is allowed, and never commits, pushes or touches the Tracker: Nightjar does that.
_Avoid_: bot, AI, model, worker

**Session**:
One run of the Coding agent on one piece of work: the Preflight, a Ticket's build, a fix round, a Step round, a Pull-check fix, a Conflict fix, a Feedback round, the Review, or a Review round. Nightjar starts and ends it; a fix round resumes the Session of the work it fixes, where that Session still exists.
_Avoid_: run, conversation, chat, job

**Logbook**:
Every Session Nightjar spent on a Feature, and each decision it made between them, in order. It stays on the person's machine.
_Avoid_: log, run log, build log, history, timeline

**Adapter**:
The piece that connects Nightjar to one Tracker or one Code host, either built in or a module the repo's config names.
_Avoid_: plugin, provider, driver, integration
