# The page reads the Tracker

`nightjar ui` read `.factory/` and nothing else, so it showed only what a running `nightjar` had written: the Queue as a Ticket count, Tickets only for the Feature being built, and nothing at all while Nightjar was off. To see upcoming work (a Feature's Tickets, their Build order and Signals, whether they meet the Ticket contract, and the person's Features that lack the Go) the person had to open the Tracker.

So the page now reads the Tracker itself, through the same `Tracker` interface the build loop uses, for the person's own Features. It only reads: it never puts on a Signal, assigns or comments, and every action stays a link to the Tracker, so the Go is still given in the Tracker alone (docs/adr/0003). Run state (what is building, spend, the Session log) still comes from `.factory/`.

## Considered Options

- **A fuller snapshot in `status.json`, written by the running `nightjar`.** It kept the page to `.factory/`, but the view would go blank whenever Nightjar is off, which is when a person most wants to look ahead.
