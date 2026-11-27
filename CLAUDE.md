# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nightjar builds a repo's Features with nobody at the keyboard: it reads Tickets from a Tracker, has a Coding agent build each one, and opens one draft pull request per Feature on a Code host. Specced in #1, with its tickets as that issue's sub-issues.

Words: `GLOSSARY.md`. Use its terms exactly. Decisions: `docs/adr/`. Judgement calls the reviewer holds the code to: `CODING_STANDARDS.md`. UI colors and design principles: `DESIGN.md` (product context: `PRODUCT.md`). `docs/design/color-scheme.md` is the brand palette for the icon, not the page.

## Build, lint, test

Node 24, TypeScript, npm. `mise.toml` pins Node 24 (`mise trust`, then `mise install`).

- `npm run check`: typecheck, lint, format check, every spec, then the build. Run it before a commit, except in a Nightjar Session: there the sandbox refuses the ports `ui`, `intake`, `serve` and the CLI specs open (EPERM), so run only the specs for the files you change, and Nightjar runs the whole check outside the sandbox after you.
- `npm test`: every spec (Vitest). One file: `npx vitest run src/build.spec.ts`; one test: `npx vitest run src/build.spec.ts -t 'hands back a Ticket'`.
- `npm run build`: compiles `src/` to `dist/`; `dist/cli.js` is the `nightjar` bin.
- `npm run lint`, `npm run format`, `npm run typecheck`.
- CI runs `npm run check` on every pull request (`.github/workflows/check.yml`); a hook in `.claude/settings.json` formats each file you change with Edit or Write; after any other edit (a script, `sed`), run `npx --no-install prettier --write <file>`, after `npm install`.
- `npm run schema`: rewrites `schema/factory.schema.json` from the zod schema in `src/config.ts`. A spec fails while the two differ.
- `npm run ui:dev [building|two-builds|review-round|conflict-fix|idle|paused|stopped|off|shelf]`: the `nightjar ui` page over mock `.factory/` files, restarting on each edit (`PORT` picks the port; `-- idle` picks the scenario).

## Architecture

The module map is `docs/architecture.md`. The rules that are not visible from the code:

- `src/build.ts`, the build loop, talks only to the `Tracker` and `CodeHost` interfaces and speaks of Signals.
- Only `src/github/` calls `gh` (a lint rule holds this); only `src/azure-devops/` calls Azure DevOps.
- Specs sit beside their code as `*.spec.ts` and run over `src/fakes/`. `src/cli.run.spec.ts` runs the real command end to end; `src/fakes/machine.ts` is a machine of stand-ins (git checkout, `gh`, `az`, `claude`, and `bwrap` and `socat` for the sandbox check, alone on the PATH; `machine(['bwrap'])` leaves one off), so a stand-in script may use shell builtins only. `cli.run.spec.ts`, and the `init` and `doctor` specs, share its one `claude`. A spec that runs `runNightjar` in this process passes a `FakeGitHub` as `Host.gh` (and a `FakeAzureDevOps` as `Host.request`); only `cli.run.spec.ts`, which runs a process, reaches the machine's `gh`.
- Sessions run in the sandbox (`src/settings.ts`): no network, no port. Nightjar's own `setup`, check and `serve` run outside it (`src/check.ts`, ADR 0005), so a check a Session runs can fail where Nightjar's passes.
- A Workflow only adds Steps to the loop: it can never loosen the deny rules in `src/settings.ts`.
- Specs use placeholder repo names (`o/app`); `scripts/leak-check.spec.ts` rejects a real one, even from a ticket mockup.
- A fresh worktree has no `node_modules`: run `npm install` before `npm run check`.

## Agent skills

### Pull requests

Write the PR body with the `pr` skill.

### Issue tracker

GitHub Issues (`nonameolsson/nightjar`) via `gh api` (REST); `gh issue` and `gh pr` fail in a cloud session. Use `gh api` over the GitHub MCP tools, whose issue reads return every body in full. Before reading or writing an issue, see `docs/agents/issue-tracker.md`: it says how to tell whether a pull request already built it. When a person asks why a Feature's build went wrong, see `docs/agents/diagnosing-a-build.md`.

### Model and effort

Before building tickets (`/implement-spec`, `/implement`), see `docs/agents/model-and-effort.md`: each ticket names the model and effort its implementer runs on.

### Triage labels

Default five labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. Before reading or writing `GLOSSARY.md` or an ADR, and when a grilling settles, see `docs/agents/domain.md`.
