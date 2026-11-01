# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nightjar builds a repo's Features with nobody at the keyboard: it reads Tickets from a Tracker, has a Coding agent build each one, and opens one draft pull request per Feature on a Code host. Specced in #1, with its tickets as that issue's sub-issues.

Words: `GLOSSARY.md`. Use its terms exactly. Decisions: `docs/adr/`. Judgement calls the reviewer holds the code to: `CODING_STANDARDS.md`.

## Build, lint, test

Node 24, TypeScript, npm.

- `npm run check`: typecheck, lint, format check, every spec, then the build. Run it before a commit.
- `npm test`: every spec (Vitest). One file: `npx vitest run src/build.spec.ts`; one test: `npx vitest run src/build.spec.ts -t 'hands back a Ticket'`.
- `npm run build`: compiles `src/` to `dist/`; `dist/cli.js` is the `nightjar` bin.
- `npm run lint`, `npm run format`, `npm run typecheck`.
- CI runs `npm run check` on every pull request (`.github/workflows/check.yml`); a hook in `.claude/settings.json` formats each file you edit.
- `npm run schema`: rewrites `schema/factory.schema.json` from the zod schema in `src/config.ts`. A spec fails while the two differ.

## Architecture

The module map is `docs/architecture.md`. The rules that are not visible from the code:

- `src/build.ts`, the build loop, talks only to the `Tracker` and `CodeHost` interfaces and speaks of Signals.
- Only `src/github/` calls `gh` (a lint rule holds this); only `src/azure-devops/` calls Azure DevOps.
- Specs sit beside their code as `*.spec.ts` and run over `src/fakes/`. `src/cli.run.spec.ts` runs the real command end to end; `src/fakes/machine.ts` is a machine of stand-ins (git checkout, `gh`, `az`, `claude` alone on the PATH), so a stand-in script may use shell builtins only. `cli.run.spec.ts` carries its own `claude` and `gh`: a change to what Nightjar asks `claude` must be made in both `claude` stand-ins.
- A Workflow only adds Steps to the loop: it can never loosen the deny rules in `src/settings.ts`.

## Agent skills

### Pull requests

Write the PR body with the `pr` skill.

### Issue tracker

GitHub Issues (`nonameolsson/nightjar`) via `gh api` (REST); `gh issue` and `gh pr` fail in a cloud session. See `docs/agents/issue-tracker.md`.

### Model and effort

Each ticket names the model and effort to build it on, in `**Model:**` and
`**Effort:**` lines under its `**Status:**`. A session that builds tickets
(`/implement-spec`, `/implement`) runs each ticket's implementer on that
ticket's own model and effort, and treats these lines as the person's request
for those settings. A ticket without them runs on `sonnet` at `high`.

### Triage labels

Default five labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.
