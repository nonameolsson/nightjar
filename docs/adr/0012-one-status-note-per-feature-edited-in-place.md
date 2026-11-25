# One Status note per Feature, edited in place; a person is told by a new comment

Nightjar used to post a new comment on a Feature for every event, so a Feature built more than once filled up with stale comments, and some events, like a pause, said nothing on the Tracker at all. Now Nightjar keeps one Status note on each Feature and rewrites it as the build goes on. The note opens with the Board's state word and one sentence, then lists the Tickets, the pull request, the Next step, and one line for each earlier run. Editing a comment notifies no one. So when a Feature needs a person, Nightjar still posts a new comment that stands on its own: the headline, the cause, and the Next step. Every way a Feature ends leaves its word in the Status note, including a pause, a stop, or a fault. The Status note is a summary: the pull request body holds the full report, and the Logbook stays on the person's machine. The page reads a Feature's reason and Next step from the Status note (docs/adr/0009).

## Considered Options

- **A new comment for every event.** Rejected: the current state is buried under every past one, and a reader has to work out which comment still holds.
- **One comment for everything, questions included.** Rejected: an edit sends no notification, so a person who is needed would never hear about it.
- **Raw logs or transcripts in the comments.** Rejected: they are too long to read on a Tracker, and they can hold what the person would not share there. The Tracker gets a short excerpt only when there is no pull request to point to.
