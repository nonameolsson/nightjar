# The page reads the Code host for a Feature's Standing

The Board showed every Feature whose last build opened a draft under Completed, though a draft is far from done: Nightjar may still run a Feedback round, a Pull-check fix or a Conflict fix on it, Publish it, and a person still has to merge it. Nightjar takes the Go off when the draft opens, so such a Feature also sat on the Shelf. The page could not tell these apart, because it read only `.factory/` and the Tracker (docs/adr/0009).

So the page now also reads the Code host, through the same `CodeHost` interface the build loop uses, for Nightjar's own pull requests on the person's Features: whether each is open as a draft, published, merged or closed. That gives each Feature one Standing, Pull request or Merged among them. The page still only reads: it never comments, publishes or merges.

## Considered Options

- **Keep Completed, read from `.factory/` alone.** Rejected: it cannot tell an open draft from a merged one, and a Feature built on another machine never shows.
- **A Signal for "pull request open".** Rejected: the Code host already knows, and a Signal would be one more mark Nightjar must keep true by hand (docs/adr/0002).
