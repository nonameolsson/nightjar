# A Feature built again while it has finished runs: one card or two?

Research note, read 2026-11-24. Every source below was read on that date.

## 1. Question and short answer

How do build and CI dashboards, work boards and coding-agent tools show an item (a job, pipeline, app, task, issue) that is running again now while it also has earlier finished runs? Do they show it once, at its current state, or in a "running" list and a "completed/history" list at the same time? What should Nightjar's Board do with a Feature that is in Building or Waiting on you and also has finished runs?

Short answer:

- Every tool checked separates two shapes. An **entity view** (pipeline, branch, application, automation, issue, session) lists each entity once, at its current state, with the latest run's outcome. A **runs view** (activity, run history, events, sync history) lists every run once, the running one included. No tool documents an entity view that shows the same entity in a "running" group and a "completed" group at once.
- Where a rerun belongs to the same record (GitHub Actions attempts, GitLab pipeline retry, Buildkite job retry, Argo CD sync), the record keeps one place and its earlier attempts sit behind it: a **Latest** dropdown, hidden retried jobs, a history field.
- Boards with status columns (Jira, GitHub Projects, Kanban) put an item in the column of its current status. Reopening an item moves it out of Done; nothing keeps a copy in Done.
- Agent tools (Devin, Factory, OpenHands, Linear agent sessions, Copilot) give a session or automation one current status. Factory's automation list says **Running** while a run is in progress and keeps past runs in an **Events** feed; Devin's sidebar groups each session under one of Working, Ready, Blocked, Inactive.
- So the evidence supports the team's lean: on the Board a Feature sits on one Mat, where it is now, and its finished runs move behind it. Nightjar's Table today is not a runs view (it folds runs the same way), so "history in the Table" needs work if it is to be the place for runs.

## 2. How Nightjar does it today

- `features()` (`src/ui.ts:304-439`) builds the Board's cards. `building` is the one Feature the run's `doing` names (`:309-327`); `waiting` comes from `status.waitingOnYou` (`:328`, `:369-423`); `queue` from `status.queue` (`:424-436`).
- Completed folds `view.completed` into one card per Feature: its latest run and a run count, ordered by latest run (`:357-368`). The card says "1 recent run" or "latest of N recent runs" (`runsText`, `:265`).
- Nothing checks a Completed card against the Building, Waiting or Queue cards. A Feature built again (a Feedback round, a new Go after needs info, a fix of Pull checks in its Slot) shows on the Building Mat and the Completed Mat at once; the same holds for Waiting on you and Queue.
- The Table view uses the same `features()` result (`src/ui.ts:681-746`): one row for the building card, one per waiting card, one per completed card. So it repeats the double entry, and it shows one row per Feature with "latest of N", not one row per run. The full record of what happened stays in the Logbook.

## 3. Per-tool findings

### Summary table

| Tool | Entity view (one row per entity, current state) | Runs view (every run) | Rerun is | Same entity in "running" and "done" at once? |
|---|---|---|---|---|
| GitHub Actions | Not as a separate page | Workflow runs list | New attempt of the same run; **Latest** dropdown for earlier attempts | No: one run, one row (inferred, see below) |
| GitLab CI | Pipelines list, Branches/Tags scope: latest pipeline per ref | Pipelines list, All/Finished scopes | Retry reuses the pipeline id; retried job gets a new job id | Not documented |
| Buildkite | Not checked | Builds | New job in the build; retried jobs hidden by default | Not documented |
| CircleCI | Not checked | Pipelines page | New workflow inside the same pipeline | Not documented |
| Jenkins Blue Ocean | Pipelines list; Branches tab (latest completed or active run per branch) | Activity tab (latest completed or active runs) | New run | No: Branches shows one row per branch |
| Argo CD | Application with current sync, health and ongoing operation | Sync history (`status.history`, `argocd app history`) | New sync operation on the same Application | No: one Application, history behind it |
| Jira | Board columns by status | Not applicable | Reopen changes status | No: one column per status |
| GitHub Projects / Issues | Board columns by a single-select field | Not applicable | Reopen sets a non-closed status | No |
| Linear | Active view: Unstarted and Started only | Not applicable | Agent moves the issue to a started status | No |
| Devin | Sessions sidebar grouped Working / Ready / Blocked / Inactive | Not documented | Sleeping session is resumed | No: one group per session |
| Factory (automations) | Automations list: Running, Active, Paused, Degraded, Failed | Events feed, filtered to Runs | New run of the same automation | No: list says Running; runs in Events |
| OpenHands Cloud | Conversation with one sandbox status and one execution status | Not documented | Not documented | No: one status pair per conversation |
| Copilot cloud agent | Not documented | Agents panel: sessions list | New session on the same PR | Not documented |
| Sweep | No first-party source found | | | |

### GitHub Actions

- A re-run is another attempt of the same run, not a new run: "To the right of the run name, select the **Latest** dropdown menu and click a previous run attempt." "A workflow run can be re-run a maximum of 50 times." ([re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs))
- The REST API exposes a run's `run_attempt` and a separate endpoint, "Gets a specific workflow run attempt", at `/actions/runs/{run_id}/attempts/{attempt_number}` ([workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs)). `gh run view --attempt` "The attempt number of the workflow run." ([gh run view](https://cli.github.com/manual/gh_run_view))
- Unverified: that the runs list shows a re-run run once, at its latest attempt's status. The docs say only to click a run in "the list of workflow runs" ([view workflow run history](https://docs.github.com/en/actions/how-tos/monitor-workflows/view-workflow-run-history)). It follows from one run id per row with `run_attempt` on it, but no page states it.

### GitLab CI

- Retrying a pipeline keeps it: `POST /pipelines/46/retry` "Retries failed or canceled jobs in a pipeline" and returns `"id": 46` ([pipelines API](https://docs.gitlab.com/api/pipelines/)).
- A retried job is a new record: "A new job instance is created with a new job ID." ([jobs](https://docs.gitlab.com/ci/jobs/)) Duration ignores the earlier attempt: "Because A is retried, it is ignored, and only job A' is counted." ([pipelines](https://docs.gitlab.com/ci/pipelines/))
- Both shapes exist side by side in the list endpoint's `scope`: "Return pipelines in the specified scope: `running`, `pending`, `finished`, `branches`, or `tags`." ([pipelines API](https://docs.gitlab.com/api/pipelines/)) `branches`/`tags` return the latest pipeline per ref (entity view); the others are runs. GLQL has a `latest` field: "Display whether this is the latest pipeline for the ref." ([GLQL pipelines](https://docs.gitlab.com/user/glql/data_sources/pipelines/))
- Not documented: how the pipelines UI marks a running pipeline whose ref also has finished pipelines.

### Buildkite

- "If you retry a job, the information about the failed job(s) remains, and a new job is created." "The history of retried jobs is preserved and immutable." "Such jobs are hidden by default—you can expand and view all the hidden retried jobs." ([retry](https://buildkite.com/docs/pipelines/configure/retry))
- So inside a build the current attempt is shown and earlier attempts are folded behind it. The pipelines dashboard was not checked.

### CircleCI

- "The rerun is a new workflow in the same run, and the output gives its ID." ([CircleCI blog, CLI for coding agents](https://circleci.com/blog/getting-started-with-the-circleci-cli/)) Rerun from failed is started from the workflow's row on the Pipelines page ([workflows](https://circleci.com/docs/guides/orchestrate/workflows/)).
- Not documented: how the Pipelines page shows the old and new workflow together.

### Jenkins (Blue Ocean)

- Blue Ocean "has been deprecated since July 2026" ([activity](https://www.jenkins.io/doc/book/blueocean/activity/)), but its docs show the two shapes cleanly.
- Entity view: "The list shows the overall state of each Pipeline configured in the Jenkins controller", with a health icon from the share of recent runs that passed ([dashboard](https://www.jenkins.io/doc/book/blueocean/dashboard/)). The Branches tab lists "all branches that have a completed or active run in the current Pipeline", each with health from its most recent run ([activity](https://www.jenkins.io/doc/book/blueocean/activity/)).
- Runs view: the Activity tab shows "a list of the latest completed or active runs", so a running build is one row among the runs, and the branch has one row ([activity](https://www.jenkins.io/doc/book/blueocean/activity/)).

### Argo CD

- One Application object holds current state and history apart. In `ApplicationStatus`: `Sync` "contains information about the application's current sync status"; `Health` "current health status"; `OperationState` "contains information about any ongoing operations, such as a sync"; `History` "contains information about the application's sync history"; `RevisionHistory` "contains history information about a previous sync" ([types.go](https://raw.githubusercontent.com/argoproj/argo-cd/master/pkg/apis/application/v1alpha1/types.go)).
- History is a separate command: `argocd app history APPNAME`, "Show application deployment history" ([argocd app history](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_history/)).
- The official UI page for history and rollback was not found (the old URL is a 404); only the API and CLI are cited here.

### Kanban practice

- The Kanban Guide (May 2025): work items flow through "one or more defined states ... from started to finished"; "Any work items between a started point and a finished point are considered work in progress (WIP)"; WIP is "The number of work items started but not finished." ([Kanban Guide](https://kanbanguides.org/english/))
- The Guide does not say outright that an item is in one state at a time, or what happens on reopening. Opinion: by its WIP definition, an item started again is WIP, not finished; counting it in both would count it twice.

### Jira

- "At its most basic, a column describes the current status of a work item." "Jira only considers work items in the right-most column of your board as complete." Unmapped statuses "hide work items both in your board view and backlog view." ([configure columns](https://support.atlassian.com/jira-software-cloud/docs/configure-columns/))
- So a work item is where its status is; a reopened item leaves the done column. Jira's docs on reopening were not checked.

### GitHub Projects and Issues

- Board columns come from one field: you can "set any other single select or iteration field as the column field"; dragging a card means "the value of those items will adjust to match the column you drag them to." ([board layout](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-board-layout))
- "When issues or pull requests in your project are closed, their status is set to **Done**." ([built-in automations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations))
- "Reopening an issue without choosing a status sets Backlog." "choosing a status in any other category for a closed issue reopens it." ([issue status webhooks and workflows](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/issue-status-webhooks-and-workflows))

### Linear

- "Active shows all active issues on your team, which are the issues under Unstarted or Started categories"; the Issues page "includes completed and canceled issues." ([team pages](https://linear.app/docs/default-team-pages))
- Agents: "AgentSession tracks the lifecycle of an agent run", created "when an agent is mentioned or delegated an issue"; sessions "can have one of 6 states: pending, active, error, awaitingInput, complete, stale." ([agent interaction](https://linear.app/developers/agent-interaction))
- Agents should "move the issue to the first status in `started` when your agent begins work", unless the issue is already `started`, `completed` or `canceled` ([agent best practices](https://linear.app/developers/agent-best-practices)). So the issue keeps one status, and the agent's runs are sessions on it.
- Not verified: the issue-status page (`/docs/configuring-workflows`) returned 404 to the fetcher; how several sessions on one issue are listed is not documented.

### Devin

- "The sessions sidebar's "Group by status" now uses Working / Ready / Blocked / Inactive, so sessions with a PR awaiting review and sessions that need your input are listed separately." (release notes, 2026-09-25, [overview](https://docs.devin.ai/release-notes/overview))
- Sessions sleep and resume: "Sessions can be resumed for 14 days after they go to sleep" (release notes, 2026-10-09, same page).
- API: `status_detail` gives "Additional detail about the session's current status", with `working`, `waiting_for_user`, `waiting_for_approval` or `finished` while running ([get session](https://docs.devin.ai/api-reference/v3/sessions/get-enterprise-session)).
- Not documented: which group a woken session moves to. Opinion: it moves to Working, since each session has one current status.

### Factory

- Automations list, one row per automation with its status: **Running** "A run is in progress."; **Active** "The automation is on and waiting for its next trigger."; **Degraded** "Its first run, or a retried run, failed."; **Failed** "The latest run failed." ([automations](https://docs.factory.com/software-factory/automations))
- Runs live elsewhere: the **Events** feed on the automation's page, "newest first", filtered to **Runs**, shows "Each run's outcome and duration, with a link to its session." (same page)
- Sessions API: `status` is "Current session execution status", `idle`, `pending` or `running`; completion is a separate `completedAt` ([sessions API](https://docs.factory.com/api-reference/sessions)).
- This is the closest match to Nightjar's case: an entity that has finished runs and runs again shows **Running**, once, and its past runs sit in a history list behind it.

### OpenHands Cloud

- Each conversation has one `sandbox_status` (`STARTING`, `RUNNING`, `PAUSED`, `ERROR`, `MISSING`) and one `execution_status` (`idle`, `running`, `paused`, `waiting_for_confirmation`, `finished`, `error`, `stuck`) ([cloud API](https://docs.openhands.dev/openhands/usage/cloud/cloud-api)).
- Not documented: how the web UI lists a conversation that ran, finished, and runs again.

### GitHub Copilot cloud agent

- "Sessions that you started, or that another user prompted Copilot to work on, appear in your sessions list." "Archive stopped sessions to remove them from your sessions list." ([manage and track agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents))
- A comment on an existing PR starts a new session; "Copilot has started work" appears in the PR timeline, and "Copilot remembers context from previous sessions on the same pull request." ([make changes to an existing PR](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr))
- So Copilot's list is a runs view (one row per session), and the PR is the entity. Not documented: whether the list groups sessions by PR or by status.

### Sweep

- No first-party source found on how Sweep shows a re-run issue. Skipped.

## 4. Patterns

1. **One row per entity, at its current state; runs behind it.** Jenkins Blue Ocean Pipelines and Branches, GitLab `branches`/`tags` scope, Argo CD Applications, Factory automations, Devin's status groups, boards with status columns. The row's state is the running run's state if one runs, else the latest run's outcome (Factory's **Running** vs **Failed** "The latest run failed"; Blue Ocean's "latest completed or active run").
2. **One row per run, the running one included.** GitHub Actions runs, GitLab All/Finished, Blue Ocean Activity, Factory Events, Copilot sessions. Here an entity appears many times, but each run once, and the running run is just the newest row.
3. **Attempts fold into the run.** GitHub Actions' **Latest** dropdown, GitLab pipeline retry keeping its id, Buildkite's hidden retried jobs. Earlier attempts stay reachable, one click behind the current one.

No source shows a mix of 1 and 2: an entity in a "running" group and again in a "finished" group of the same view. Nightjar's Board does exactly that today, because its Mats are entity groups (one card per Feature, by state) while Completed is filled from runs.

## 5. Recommendation for Nightjar's Board

Facts are cited above; this section is opinion.

- **Board: one card per Feature, on one Mat.** The Board's Mats are states of a Feature (GLOSSARY: Mat, "one state's lane"), so it is pattern 1. A Feature on Building, Waiting on you or Queue should not also be on Completed. In `features()`, drop a Completed card whose `id` is on another Mat. This is what Factory (Running, once) and Jira (one column per status) do.
- **Keep the history one click away.** Like GitHub's **Latest** dropdown or Buildkite's hidden retried jobs, the active card can say "N earlier runs" (the count the Completed fold already makes) and link to them. When the Feature finishes, it returns to Completed as "latest of N recent runs", as today.
- **One precedence for every Mat, not only Completed.** Waiting on you, then Building, then Queue, then Completed, so a Feature waiting on a person shows where it needs them. Check that Waiting on you and Building cannot hold the same Feature either.
- **If the Table is to hold history, make it a runs view.** Today it shares `features()` and folds runs into one row per Feature, so hiding Completed rows there would lose information it does not show elsewhere either. Either (a) give the Table the same one-row-per-Feature rule and leave run history to the Logbook, or (b) make it pattern 2: one row per run, the building run as its newest row, as GitHub Actions and Blue Ocean Activity do. (b) matches the team's lean "history in the Table"; (a) is the smaller change.

## 6. Sources (all read 2026-11-24)

- GitHub Actions: [re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs); [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs); [view workflow run history](https://docs.github.com/en/actions/how-tos/monitor-workflows/view-workflow-run-history); [gh run view](https://cli.github.com/manual/gh_run_view)
- GitLab: [pipelines](https://docs.gitlab.com/ci/pipelines/); [pipelines API](https://docs.gitlab.com/api/pipelines/); [jobs](https://docs.gitlab.com/ci/jobs/); [GLQL pipelines](https://docs.gitlab.com/user/glql/data_sources/pipelines/)
- Buildkite: [retry](https://buildkite.com/docs/pipelines/configure/retry)
- CircleCI: [workflows](https://circleci.com/docs/guides/orchestrate/workflows/); [CLI for coding agents](https://circleci.com/blog/getting-started-with-the-circleci-cli/)
- Jenkins: [Blue Ocean dashboard](https://www.jenkins.io/doc/book/blueocean/dashboard/); [Blue Ocean activity](https://www.jenkins.io/doc/book/blueocean/activity/)
- Argo CD: [types.go](https://raw.githubusercontent.com/argoproj/argo-cd/master/pkg/apis/application/v1alpha1/types.go); [argocd app history](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_history/)
- Kanban: [The Kanban Guide](https://kanbanguides.org/english/)
- Jira: [configure columns](https://support.atlassian.com/jira-software-cloud/docs/configure-columns/)
- GitHub Projects and Issues: [board layout](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-board-layout); [built-in automations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations); [issue status webhooks and workflows](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/issue-status-webhooks-and-workflows)
- Linear: [team pages](https://linear.app/docs/default-team-pages); [agent interaction](https://linear.app/developers/agent-interaction); [agent best practices](https://linear.app/developers/agent-best-practices)
- Devin: [release notes](https://docs.devin.ai/release-notes/overview); [get session](https://docs.devin.ai/api-reference/v3/sessions/get-enterprise-session)
- Factory: [automations](https://docs.factory.com/software-factory/automations); [sessions API](https://docs.factory.com/api-reference/sessions)
- OpenHands: [cloud API](https://docs.openhands.dev/openhands/usage/cloud/cloud-api)
- GitHub Copilot: [manage and track agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents); [make changes to an existing PR](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr)
