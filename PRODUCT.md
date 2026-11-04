# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
A developer running Nightjar on their own machine who has queued Features and walked away. They open `nightjar ui` to check on their own runs: what is building, which Ticket is stuck, which draft pull requests are ready. Mostly glancing, sometimes debugging a failed or blocked build.

## Product Purpose
Nightjar is a command-line tool that builds a repo's Features with nobody at the keyboard. It reads Tickets from a Tracker (GitHub Issues or Azure DevOps Boards), has a Coding agent (Claude Code) build each one, and opens one draft pull request per Feature on a Code host (GitHub or Azure Repos). The UI (Board, Table and Overview views, served by `nightjar ui`) lets the person see the state of that work without reading terminal logs. Success: the person understands the state of their Queue in seconds and knows what, if anything, needs them.

## Positioning
A software factory that runs unattended on the person's own machine and logins, one draft PR per Feature, driven by the Tracker's specs rather than a chat session.

## Operating Context
Local, single-person tool: runs on macOS, Linux or WSL2 with the person's own `gh`/`az`, `git` and `claude` sign-ins. The UI is a local web page for a repo whose `factory.json` is committed; run state lives in `.factory/`.

## Capabilities and Constraints
- Domain vocabulary is fixed by `GLOSSARY.md` (Feature, Ticket, Signal, Go, Queue, Workflow, Step, ...); UI copy uses these terms exactly.
- UI views today: Board, Table, Overview (`src/ui.ts`, `src/ui-command.ts`).
- Hosted/team-wide oversight of many people's Queues is not a goal confirmed here.

## Brand Commitments
- No binding palette. The earlier "Neon After Dark" palette (`docs/design/color-scheme.md`) is a reference only; the UI redesign chooses its own world. The shipped UI is thrown away.
- Brand assets: `docs/design/assets/` (banner, icon, wordmark).

## Evidence on Hand
Real run data comes from the tool itself; no testimonials, customers or benchmarks exist. Do not fabricate any.

## Product Principles
- The person is away: show state and what needs them first, not activity for its own sake.
- Speak the glossary: one term per concept, matching the CLI and the Tracker.
- Truthful status: never imply a Ticket or Feature is further along than the Signals show.
- Quiet by default, loud only when a human is needed.

## Accessibility & Inclusion
WCAG AA: sufficient contrast (including neon accents on dark surfaces) and full keyboard operation.
