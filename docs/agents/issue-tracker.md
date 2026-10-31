# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on `nonameolsson/nightjar`.

Use `gh api` (REST) for every operation, never `gh issue …` or `gh pr …`. Those
use GraphQL, which a Claude Code cloud session refuses (HTTP 403); `gh api` works
everywhere. `gh api` fills in `{owner}/{repo}` from the clone's `origin`. A body
with more than one line goes in through a heredoc into `-F body=@-`.

## Conventions

- **Create an issue**: `gh api -X POST repos/{owner}/{repo}/issues -f title='…' -F body=@- -f 'labels[]=…'`.
  The answer's `number` is the `#number`; its `id` is the **database id**, which
  the sub-issue and blocking calls take.
- **Read an issue**: `gh api repos/{owner}/{repo}/issues/<n>`, and its comments with
  `gh api repos/{owner}/{repo}/issues/<n>/comments`.
- **List issues**: `gh api 'repos/{owner}/{repo}/issues?state=open&labels=<label>' --jq '[.[] | select(.pull_request | not) | {number, title, labels: [.labels[].name]}]'`.
  This endpoint returns pull requests too; the `select` drops them.
- **Make an issue a sub-issue of a parent**: `gh api -X POST repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`.
  List them with `gh api repos/{owner}/{repo}/issues/<parent>/sub_issues`.
- **Blocking**: GitHub's native issue dependencies:
  `gh api -X POST repos/{owner}/{repo}/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Read them with `gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by`.
  A ticket is unblocked when every blocker is closed.
- **Comment on an issue**: `gh api -X POST repos/{owner}/{repo}/issues/<n>/comments -F body=@-`.
- **Apply / remove labels**: `gh api -X POST repos/{owner}/{repo}/issues/<n>/labels -f 'labels[]=<label>'`;
  remove one with `gh api -X DELETE repos/{owner}/{repo}/issues/<n>/labels/<label>`.
- **Assign**: `gh api -X POST repos/{owner}/{repo}/issues/<n>/assignees -f 'assignees[]=<login>'`.
- **Close**: `gh api -X PATCH repos/{owner}/{repo}/issues/<n> -f state=closed -f state_reason=completed`
  (`not_planned` for one ruled out).

## Pull requests

- **Open**: `gh api -X POST repos/{owner}/{repo}/pulls -f title='…' -f head=<branch> -f base=main -F body=@- -F draft=true`.
- **Read**: `gh api repos/{owner}/{repo}/pulls/<n>`, the diff with
  `gh api repos/{owner}/{repo}/pulls/<n> -H 'Accept: application/vnd.github.diff'`.
- **Edit**: `gh api -X PATCH repos/{owner}/{repo}/pulls/<n> -F body=@-`.
- **Comment**: as on an issue, `repos/{owner}/{repo}/issues/<n>/comments`.
- **Mark ready for review**: GraphQL only on GitHub. In a cloud session use
  `gh api -X POST repos/{owner}/{repo}/pulls/<n>/ccr/ready_for_review`; on your own
  machine `gh pr ready <n>` works.
- A ticket is done when the pull request whose body says `Closes #<ticket>` is
  merged.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues:

- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: the issue calls above, with the PR's number.

GitHub shares one number space across issues and PRs, so a bare `#42` may be
either: `gh api repos/{owner}/{repo}/issues/42` answers for both, and carries a
`pull_request` key when it is one.

## When a skill says "publish to the issue tracker"

Create a GitHub issue, as **Create an issue** above.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a sub-issue of the map (see **Make an issue a sub-issue of a parent**), labelled `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's native issue dependencies, as **Blocking** above.
- **Frontier query**: the map's open sub-issues with no open blocker (`issue_dependencies_summary.blocked_by` is 0) and no assignee; first in map order wins.
- **Claim**: assign the ticket to yourself (**Assign** above), the session's first write.
- **Resolve**: comment the answer, close the issue, then append a context pointer (gist + link) to the map's Decisions-so-far.
