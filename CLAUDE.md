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
- `src/azure-devops/` holds the Azure DevOps adapters, the only code that calls Azure DevOps: `sign-in.ts` (the `az` token, else `AZURE_DEVOPS_EXT_PAT`), `api.ts` (the one signed-in HTTP layer, with a request seam), `index.ts` (`openAzureDevOps`, one API every Azure DevOps adapter shares), `tracker.ts` (Boards), `code-host.ts` (Azure Repos; it links work items when `src/adapters.ts` pairs it with Boards of the same organization, else names Tickets in the body), and `fake-azure-devops.ts`, the in-memory Azure DevOps its specs run the real adapters over.
- `src/config.ts` loads and validates `factory.json`; `src/person-config.ts` the person's own optional `~/.config/nightjar/config.json` (`dailyUsd`, `assignee`), found through the injected env; `src/adapters.ts` builds the adapters `factory.json` names. `src/adapter-module.ts` loads a repo's own adapter from a `type: "module"` entry and refuses one that lacks an export or a method (`docs/custom-adapters.md`).
- `src/contract/` is the Adapter contract suite (`feature-writer.ts` is the creation suite, run over a Tracker that also implements the optional `FeatureWriter`); `run.ts` runs it without a test runner and `command.ts` is `nightjar contract MODULE` (the module exports `trackerHarness` and/or `codeHostHarness`).
- `src/main.ts` is the command (`src/cli.ts` runs it); `runNightjar(argv, host)` takes the platform, env, cwd, and init's `ask` from a `Host`, which specs inject. It stops every command on `win32` first. `src/queue.ts` picks the next Feature for `--once` and `--watch`.
- `src/checks.ts` runs the checks (API key, Node, checkout, `factory.json`, Tracker and Code host logins, `claude` installed and signed in, commit signing): a build stops at the first failure, `src/doctor.ts` (`nightjar doctor`, alias `--dry-run`) runs all and lists them, and `src/init.ts` (`nightjar init`, answers on stdin through `src/ask.ts`) writes `factory.json`, calls `Adapters.prepareSignals` (`src/github/labels.ts` creates the labels) and then runs the same checks.
- `src/create.ts` is `nightjar create FILE`: `src/feature-file.ts` reads a Feature file in the shape of `docs/ticket-contract.md`, and the configured Tracker makes it through `FeatureWriter`. `skills/nightjar-feature/` is the Claude Code skill the package ships, which writes that file.
- `src/workflow.ts` picks a Feature's Workflow (its `**Workflow:**` line, else `defaultWorkflow`) and renders the pull request's section on it; `FeatureRun.runSteps` in `build.ts` runs the Steps (after each Ticket, or after all of them before the review), each ending in its own commit with a `Factory-Step` trailer or thrown away. `serve.ts` starts a Workflow's serve command, `skills.ts` lists the skills a headless session loads (`checks.ts` checks each Step's `/skill` against them, per Workflow), and `settings.ts` adds a Workflow's commands, tools and localhost network to its Steps without touching the deny rules.
- Around the loop: `worktree.ts` (git in the Feature's worktree under `~/.nightjar/worktrees/`), `session.ts` (one headless `claude -p`), `settings.ts` (the agent's allow list from config, and the deny rules config cannot loosen), `check.ts` (the repo's check command), `prompt.ts`, `plan.ts` (Build order), and `ports.ts` (the lock scheme that reserves `ports` per run, held until the process ends), and `ledger.ts` and `status.ts` (`.factory/runs.jsonl` and `.factory/status.json` in the repo).
- Specs sit beside their code as `*.spec.ts`. `src/cli.run.spec.ts` runs the real command end to end over stand-ins for `gh` and `claude`; `src/fakes/machine.ts` is a whole machine of stand-ins (git checkout, `gh`, `az`, `claude` alone on the PATH) for the `init` and `doctor` specs.

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
