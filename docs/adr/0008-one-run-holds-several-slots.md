# One run holds several Slots, and reserves each Session's cap against the day

A `--watch` run built one Feature at a time. Worktrees and reserved ports already kept two processes apart, so two Features could be built at once by starting a second process, but each process wrote the one `.factory/status.json`, kept its own view of the day's spend, and paused on its own. A run now holds as many Slots as the person sets (`parallel` in their own config, else `--parallel N`; one unless they say more), each taking one Feature's build, Pull-check fix or Feedback round, and a Feature is never in two at once. A second process in the same repo stays unsupported. So that `dailyUsd` holds as it did with one Slot, a Session starts only when the day's spend, plus the caps of the Sessions running in the other Slots, plus its own cap, fits under it; when the day is over, no Slot takes new work and running Sessions finish. One Session reaching the plan's usage limit pauses the whole run, and every Slot resumes together.

## Considered Options

- **Several processes, one per Feature.** Rejected: they would need a lock or shared file to share the status file, the day's spend, the Queue's picks and the pause.
- **Check the day's spend before each Session only, as with one Slot.** Rejected: the day could then overshoot by one Session's cap per Slot, not one in all.
- **Build a Feature's independent Tickets at once.** Rejected: a Ticket is one commit on the Feature's one branch, and building them at once would need merging inside the Feature.
- **Back off per Slot on the usage limit.** Rejected: the limit is the login's, so every Slot hits it at once, and backing off each one only multiplies the failed calls.

## Consequences

The usage limit and the number of Slots belong to a Claude login, which Nightjar takes from the terminal (`CLAUDE_CONFIG_DIR`). Two runs in two repos on one login do not coordinate: each pauses on its own usage limit, and `dailyUsd` stays per repo.
