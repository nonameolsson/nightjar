# A Feature never builds on another Feature's unmerged branch

Each Feature branches from the base branch, and its draft pull request targets the base branch, whatever other drafts are open. A Ticket blocked by a Ticket of another Feature waits until that Feature's pull request merges: the Feature is built up to it, and the wait is named. Dependent work belongs in one Feature, where the Build order handles it; Features in a Queue are expected to be independent, and chains of Features mostly come from one spec split in pieces. When the base branch moves under an open draft, Nightjar only says so in the pull request's body when it opens or updates it; it never merges or rebases the base into a draft.

## Considered Options

- **Hold a blocked Feature**: skip it, keep its Go, and take it again once the blocker merges. Rejected: it needs a Feature-level read of blockers and a way to show the wait, for a case that keeping dependent work in one Feature avoids.
- **Stack on the blocker's branch**, with the pull request based on it and retargeted when it merges, as GitHub's stacked pull requests do. Rejected: every Feedback round or Pull-check fix on the lower draft forces a rebase and force-push of the drafts above it, under any reviewer (see ADR 0004); Azure Repos has no counterpart; and Nightjar keeps each Feature in its own worktree, which `git rebase --update-refs` skips.
- **Merge or rebase the base into open drafts.** Rejected for now: a rebase rewrites what a reviewer read, a merge needs a Session to resolve conflicts that can fail, and a merge queue makes "up to date" unnecessary for merging. Merging the base into a draft no person has engaged with stays open as a later step, which [ADR 0011](0011-nightjar-merges-the-base-into-its-own-conflicting-draft.md) takes up.

Research: `docs/research/feature-queue-branching.md`. Grilled in #241.
