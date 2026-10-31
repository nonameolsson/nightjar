# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

No source, build system or tests yet: only the agent skills and their setup docs. Nightjar is specced in #1, with its tickets as that issue's sub-issues. Update this file once code lands: add build/lint/test commands (incl. single-test invocation) and architecture notes.

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
