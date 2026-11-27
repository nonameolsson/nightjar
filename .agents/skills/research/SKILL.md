---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Spin up a **background agent** to do the research, so you keep working while it reads. Start it with a fresh context window.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.

## Every note gets a Grill issue

A note nobody grills is forgotten. Once the note is written, file one GitHub
issue that holds it until it is grilled, so the open question shows on the
Tracker and not only in `docs/research/`. Use `gh api` as
`docs/agents/issue-tracker.md` says.

- **Title**: `Grill: <the question, in a few words>`.
- **Label**: `needs-triage`. No Signal: nothing here is ready to build.
- **Body**, in this order:
  - One or two lines: the question, then "This issue holds the research to grill against; nothing here is decided. The research note is `docs/research/<file>.md`", naming the pull request too while the note is unmerged.
  - `## Questions to grill`: the note's open questions, numbered.
  - `## Nightjar today`: a few lines on what exists now.
  - `## Related`: issues, ADRs and notes it touches. If an open issue already asks the same question, name it here.
  - `## Next`: "Run `/grill-with-docs` on this issue and the note. Once it settles, `/to-spec` and `/to-tickets`, then close this issue."
- **In the note**: under the "Research note, read …" line, add `Grill: #<n>.`
  When the grilling settles, the person replaces that line with an
  `Outcome:` line (as in `docs/research/feature-queue-branching.md`) and
  closes the issue.

A note that only records facts and has nothing to decide still gets the issue:
its question is "does this change anything?", and the grilling may close it as
`not_planned`.
