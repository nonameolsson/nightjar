# Nightjar merges the base into its own conflicting draft

ADR 0007 left one step open: merging the base into a draft that no person has engaged with. A draft that conflicts with its base can't be merged, and on GitHub it often gets no Pull checks at all, so Nightjar's promise to fix its own drafts until a person engages stopped short of the one fault a person always has to fix by hand. When a repo turns on `conflicts` in `factory.json`, the `--watch` revisit pass now takes a draft the Code host says conflicts, before any red draft, and runs a Conflict fix: Nightjar merges the base into the Feature's branch, and a new Session resolves the conflicts it leaves, with the Feature's spec and the base's commits since the branch forked. The repo's check and the usual fix rounds run, and Nightjar pushes one merge commit with a `Factory-Conflicts` trailer, within the block's own rounds and spend limits. A round that stays red is kept on an `-attempt-conflicts` side branch, and the Feature gets needs a person. No Review runs after it, as none runs after a Pull-check fix: the repo's check gates the result, and the Pull checks on the merge commit go to the Pull-check fix as usual. As in ADR 0004, it stops for good once a person engages. A branch that is only behind its base gets no Conflict fix.

## Considered Options

- **Rebase onto the base.** Rejected: it rewrites the branch's commits and drops their `Factory-` trailers, which are the only record of Tickets built, Feedback answered and rounds counted, and it rewrites what a reviewer may already have read.
- **Keep every draft up to date with its base.** Rejected: a merge on every push to the base is noise under any reviewer, and keeping branches current is a merge queue's or a person's call.
- **Fold it under `pullChecks.enabled`.** Rejected: pushing a merge is a bigger step than fixing a red check, and a repo should choose it on its own. Off by default.
- **Resume the head commit's Session, as a Pull-check fix does.** Rejected: that Session knows nothing of the base's changes, which are what the conflicts are about.
- **Run the Review after the fix.** Rejected for now: it costs a Review on every conflict to catch a resolution that keeps the wrong side and still passes the check.
- **Keep fixing after a person engages**, as Claude Code's own autofix does. Rejected as in ADR 0004: pushes would move the code a person is reading, and a person who wants a fix asks for one through a request for changes or a new Go, which the Feedback round answers.

Grilled with a look at how other software factories review and autofix their pull requests: their review of a PR lives on the Code host (an Action or an app), so Nightjar adds none, and keeps its own Review before the draft opens.
