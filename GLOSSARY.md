# Nightjar

A command-line tool that builds a repo's Features with nobody at the keyboard: it reads Tickets from a Tracker, has a Coding agent build each one, and opens one draft pull request per Feature on a Code host.

## Language

### Work

**Feature**:
The tracker item that holds a spec and that a person gives the go to build. A role, not a tracker type: in Azure DevOps it may be a Feature, an Epic or a Product Backlog Item.
_Avoid_: parent issue, epic, story

**Ticket**:
One buildable child of a Feature, built as one commit.
_Avoid_: sub-issue, task, story

**Ticket contract**:
What a Ticket must hold to be built: its blocking links and its acceptance criteria, and optionally Model and Effort lines that override the repo's defaults.
_Avoid_: ticket format, template

**Build order**:
The order a Feature's Tickets are built in: their blocking links, then the Feature's own child order.
_Avoid_: dependency graph, queue

### Steering

**Signal**:
One of a fixed set of marks a person or Nightjar puts on a Feature or Ticket to steer a build: the Go, ready, working, needs info, needs a person. Each Tracker shows a Signal in its own way (a label, a tag), under a name the repo configures, and never as a tracker state.
_Avoid_: label, tag, status (when the generic mark is meant)

**Go**:
The Signal by which a person tells Nightjar to build a Feature assigned to them. Its own mark, never shared with a triage role.
_Avoid_: ready-for-agent (on a Feature), start, trigger

**Trusted comment**:
A comment on a Feature or Ticket whose author Nightjar trusts, so it reaches the Coding agent. No other comment does.
_Avoid_: approved comment

### Where things are

**Tracker**:
The system that holds Features, Tickets, Signals and comments, such as GitHub Issues or Azure DevOps Boards.
_Avoid_: board, backlog, issue system

**Code host**:
The system the Feature's branch is pushed to and its draft pull request opened on, such as GitHub or Azure Repos. Set independently of the Tracker.
_Avoid_: repo host, forge, remote

**Coding agent**:
The program that builds one Ticket in the Feature's worktree, in a session Nightjar starts and ends; today only Claude Code. It edits files and runs the commands it is allowed, and never commits, pushes or touches the Tracker: Nightjar does that.
_Avoid_: bot, AI, model, worker

**Adapter**:
The piece that connects Nightjar to one Tracker or one Code host, either built in or a module the repo's config names.
_Avoid_: plugin, provider, driver, integration
