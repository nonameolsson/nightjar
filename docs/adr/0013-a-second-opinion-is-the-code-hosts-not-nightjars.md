# The Review runs on the one Coding agent; a second opinion is the Code host's

The Review runs in a fresh context on the same Coding agent that built the Feature, by default on the same model. Research on code review suggests a fresh context gets most of the benefit, and that a different, stronger model finds partly different issues ([arXiv 2610.01471](https://arxiv.org/abs/2610.01471), a small study; [Greptile, Jul 2026](https://www.greptile.com/blog/model-inversion), a vendor study). So Nightjar recommends a stronger `review.model` than the default `model`, and goes no further: it adds no second Coding agent and no reviewer from another vendor. A repo that wants another vendor's opinion on the pull request gets it from the Code host, as an Action or an app, where it reads the same pull request a person does.

## Considered Options

- **A reviewer from another vendor inside Nightjar.** Rejected: it needs a second Coding agent, with its own sandbox, deny rules, login and spend, held to ADR 0005. A Code host app already does this, on every pull request, and needs nothing from Nightjar.
- **Make a stronger review model the default.** Rejected: it raises every repo's cost without being asked, and the model names a repo can use depend on its plan.
