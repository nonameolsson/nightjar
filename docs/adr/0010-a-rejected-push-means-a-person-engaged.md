# A rejected push means a person engaged

Nightjar never force-pushes a Feature's branch, and it opens the worktree at the remote's head when the branch is only behind. So when a push fails, Nightjar fetches once. If the remote already holds its commit, the push counts as done. If the remote and Nightjar both have new commits, someone else pushed to the branch, and Nightjar counts that as a person engaging (ADR 0004). This holds whether the push follows a build, a Feedback round, a Pull-check fix or a merge of the base. Nightjar moves its own commits to a local `<branch>-attempt-push` branch, resets the branch to the remote's head, and gives the Feature needs a person with a comment that names the side branch. It never rebases or merges its work onto theirs. This rejection is how Nightjar finds out a person pushed: `personEngaged` sees only reviews and comments. A Go given again builds on top of the person's head.

## Considered Options

- **Rebase Nightjar's commits onto the person's push and push again.** Rejected: it changes the code a person is reading, and the commits were checked against a tree that no longer exists.
- **Tell another Nightjar run's commits (which carry trailers) apart from a person's.** Rejected: a second process in the same repo is unsupported (ADR 0008), so the case does not earn its own path.
- **Leave the unpushed commits on the branch for the next pass.** Rejected: the next Pull-check pass skips the branch for good, and the unpushed Feedback commit makes its Feedback look answered when no reply was ever posted.

Grilled in #294.
