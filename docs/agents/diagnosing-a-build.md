# Diagnosing a build

A person asks why a Feature's build went wrong, often from a screenshot of `nightjar ui`. The build ran on their machine; most of what it knew stays there.

## What you can read

From GitHub (`gh api`, see `issue-tracker.md`):

- **The Status note**: Nightjar's one comment on the Feature, with its state, Tickets and earlier runs.
- **The draft pull request's body**: Built, Waiting, Review, Conflicts, Cost, and the `nightjar-publish` mark.
- **The Feature's branch**, `factory/<id>-<slug>`: each commit's `Factory-` trailers say which Ticket, round or fix made it. Fetch it by name and compare it with `main`:
  - `git merge-base origin/<branch> origin/main`: the release it was cut from.
  - `git rev-list --count origin/<branch>..origin/main`: how far `main` has moved since.
  - the branch's pull requests, merged or open: a merged one means the branch's work is already on `main`, squashed, and the branch still holds the originals (#408).

Only on the person's machine:

- **The Logbook**, `.factory/logbook/<id>.jsonl`: each Session, each gate report a fix round got, each Review's issues, each Signal.
- **The Session transcripts**, `.factory/logs/`, and `.factory/runs.jsonl` for cost and outcome.
- **The worktree**, `~/.nightjar/worktrees/<repo>-<hash>/<id>-<slug>`, with any commits not yet pushed.

When the cause is in the Logbook, ask for the output of `nightjar logbook <id>`, or `nightjar logbook --session <id>` for one Session. Say which, rather than guessing from a screenshot.

## Where each command runs

Sessions run in the sandbox: no network, no port (`src/settings.ts`, ADR 0005). Nightjar's own `setup`, check and `serve` run outside it (`src/check.ts`). A check a Session runs can fail where Nightjar's passes, so "Check red" in the Logbook is Nightjar's own run, and its gate report is the real cause.

## What you can't do from a cloud session

A cloud session pushes only to its own branch: deleting a Feature's branch, removing a worktree, or stopping a run are the person's to do. Give them the commands.
