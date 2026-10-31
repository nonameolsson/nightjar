# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nightjar builds a repo's Features with nobody at the keyboard: it reads Tickets from a Tracker, has a Coding agent build each one, and opens one draft pull request per Feature on a Code host. Specced in #1, with its tickets as that issue's sub-issues.

Words: `GLOSSARY.md`. Use its terms exactly. Decisions: `docs/adr/`.

Nothing in Nightjar may assume a language or toolchain of the repo it builds.

## Build, lint, test

Node 24, TypeScript, npm.

- `npm run check`: typecheck, lint, format check, every spec, then the build. Run it before a commit.
- `npm test`: every spec (Vitest). One file: `npx vitest run src/build.spec.ts`; one test: `npx vitest run src/build.spec.ts -t 'hands back a Ticket'`.
- `npm run build`: compiles `src/` to `dist/`; `dist/cli.js` is the `nightjar` bin.
- `npm run lint`, `npm run format`, `npm run typecheck`.
- `npm run schema`: rewrites `schema/factory.schema.json` from the zod schema in `src/config.ts`. A spec fails while the two differ.

## Architecture

- `src/build.ts` is the build loop: one Feature from the Go to a draft pull request. It talks only to the `Tracker` (`src/tracker.ts`) and `CodeHost` (`src/code-host.ts`) interfaces, and speaks of Signals (`src/signals.ts`), never label names.
- `src/github/` holds the GitHub adapters, the only code that calls `gh` (a lint rule holds this). `src/fakes/` holds the in-memory Tracker and Code host the build loop's specs run over, with a scripted session.
- `src/config.ts` loads and validates `factory.json`; `src/adapters.ts` builds the adapters it names.
- `src/main.ts` is the command (`src/cli.ts` runs it); `src/queue.ts` picks the next Feature for `--once` and `--watch`.
- Around the loop: `worktree.ts` (git in the Feature's worktree under `~/.nightjar/worktrees/`), `session.ts` (one headless `claude -p`), `settings.ts` (the agent's allow list from config, and the deny rules config cannot loosen), `check.ts` (the repo's check command), `prompt.ts`, `plan.ts` (Build order), and `ports.ts` (the lock scheme that reserves `ports` per run, held until the process ends), and `ledger.ts` and `status.ts` (`.factory/runs.jsonl` and `.factory/status.json` in the repo).
- Specs sit beside their code as `*.spec.ts`. `src/cli.run.spec.ts` runs the real command end to end over stand-ins for `gh` and `claude`.

## Agent skills

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
