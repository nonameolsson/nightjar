# Nightjar may publish its own pull request when the repo opts in

Nightjar opened every pull request as a draft and never published one, so a person had to take each out of draft before anyone was asked to read it, even when Nightjar's own Review approved it and its Pull checks were green. A repo may now set `publish: true`, and Nightjar then publishes its own draft pull request once the Feature is complete, the last Review of the build approved, the Pull checks on the head commit finished green, and no person has engaged with it. It publishes only from the `--watch` revisit pass, as ADR 0004's fixes run there, once the Pull checks finish green; a pull request whose head commit still has no Pull checks some minutes after it opened counts as green. Under `--once` the pull request stays a draft. Publishing asks a person to read; it approves nothing, and Nightjar still never merges, and never turns a pull request back into a draft. Its own publishing is not a person engaging (ADR 0004).

## Considered Options

- **Never publish.** Rejected: a complete, approved, green pull request still waited on a person's click before anyone was asked to review it.
- **Always publish.** Rejected: a repo that wants every pull request read first as a draft keeps that by default.
- **Publish when the pull request opens.** Rejected: the Pull checks have not run yet, and a published pull request that then goes red asks a person to read code that does not pass.
- **Publish when the pull request opens if its head commit has no Pull checks.** Rejected: a Code host registers its checks a little after the push, so at open every pull request looks as if it had none.
- **Publish after the Review alone, with no Review round.** Rejected: an advisory Review that asks for changes would leave the pull request unpublished every time, so the Review round fixes its findings first.
