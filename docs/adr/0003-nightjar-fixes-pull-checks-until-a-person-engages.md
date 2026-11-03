# Nightjar fixes Pull checks until a person engages

Pull checks run in the Code host's own environment and can fail where the repo's check passed, so a draft pull request Nightjar opened complete may still be red. When a repo turns it on, Nightjar revisits its own red draft pull requests before taking the next Feature from the Queue, and fixes them in new commits within their own round and spend limits, then gives the Feature the needs-a-person Signal. It stops for good once a person engages: reviews, comments, pushes, marks the pull request ready, or closes it. It finds red pull requests from the Code host and counts rounds from commit trailers, never from a new Signal, so the branch stays the only record.

## Considered Options

- **Wait for the Pull checks in the same run.** Rejected: a `--watch` Queue would stall for as long as the Code host's checks take, for every Feature.
- **A separate command run by a person or a schedule.** Rejected: a red pull request would wait on someone remembering to run it, which is the keyboard Nightjar exists to remove.
- **Keep fixing after a person engages.** Rejected: pushes under a person's review move the code they are reading, and the pull request is theirs from then on.
