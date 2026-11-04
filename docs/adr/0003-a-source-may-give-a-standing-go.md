# A Source may give a standing Go

Nightjar builds only what a person has given the Go, and until now only a person gave it: `nightjar create` and a Source make Features with no Signal. Some work comes back the same every time, such as the weekly dependency update or a Sentry error that only needs reproducing and fixing, and waiting for a person to give each one the Go loses what a Source is for.

So a Source with `"go": true` gives each Feature it makes the Go, assigned to the Source's `owner`. This is the one place Nightjar gives the Go. The Go is still a person's: whoever commits a `go: true` Source to `factory.json` gives a standing Go, ahead of time, to every Feature that Source makes. The commit is that person's, under the repo's own review, and `owner` names who is answerable for each build.

The standing Go is bounded by:

- **The owner.** The owner must be trusted on the Tracker: on `factory.json`'s `trusted` list, or if there is no list, by the Tracker's own default (write access on GitHub, the project's Contributors group on Azure DevOps Boards). `nightjar intake` refuses to start, and `nightjar doctor` fails the Source, when the owner is not trusted, or when the Tracker cannot assign (it lacks the optional `assign`) or cannot say whom it trusts (it lacks `trusts`, and there is no list). Each Feature is assigned to the owner before it is given the Go, so a Go never lands on a Feature no one holds. If assigning fails, the Feature is left with no Signal for a person to give the Go.
- **`maxPerDay`.** A Source makes at most `maxPerDay` Features a day (3 by default), counted on the Tracker, so two intakes share the count.
- **The Ticket limits.** Each Ticket of a Source's Feature is built under the same limits as any other: its spend, minutes, fix rounds and question rounds, and the deny rules of `src/settings.ts`, which no Source or Workflow can loosen. A Ticket that stays unclear goes to a person, and the build ends in a draft pull request that a person merges.
- **The owner's `dailyUsd`.** The Features are built by the owner's own `--watch`, which pauses at that person's daily spend.

What does not change:

- A Source without `go` still makes its Features with no Signal and no assignee.
- `nightjar create` never gives the Go.
- The payload of a Source is still untrusted data. The Go comes from the committed `factory.json`, never from an event, so no payload can give the Go to a Source that lacks it, and none can choose the owner.
