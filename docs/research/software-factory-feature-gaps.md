# What do other software factories have that Nightjar lacks?

Research note, read 2026-11-27. Every source below was read on that date.

Outcome: none yet. Each of the three gaps in §5 is a candidate for a `/grill-with-docs` session, not a decision.

## 1. Question and short answer

What features do other software factories and background coding agents have that Nightjar lacks? Which three matter most for Nightjar?

Short answer:

- Nightjar already covers much of what the others sell: a Preflight, a Review and Review rounds, Pull-check fixes, Conflict fixes, Feedback rounds, Sources (schedule, webhook, `sentry`, `botPulls`), Workflows with a running app (`serve`, `ports`, `localNetwork`), a reproduce-first `bug` Workflow, spend limits, the Logbook, the Retro and the Measures.
- What the others have and Nightjar does not falls into three groups.
  - **Proof that it works.** Copilot, Cursor and Augment put runtime evidence (screenshots, recordings, logs) into the pull request. Tessl checks each requirement and shows pass or fail. Nightjar shows the check passed, the Review's verdict, and with the `bug` Workflow the name of a test the Session says it saw fail. Nothing checks the acceptance criteria one by one, and nothing stops the Coding agent editing a test to make the check pass.
  - **Acting from anywhere.** Jules can be paused and steered mid-task; Cursor and Codex run tasks from mobile; Devin has a notification inbox; Factory and Cursor take work from Slack. Nightjar's page only reads (ADR 0009): the Go, answers to needs info, and stopping a build all happen in the Tracker or at the terminal.
  - **Running while the laptop is closed.** Every hosted tool runs in its own cloud machine (Copilot on Actions runners, Codex and Cursor in cloud containers or VMs, Kiro crews on EC2, CodeBuild and Actions). Nightjar runs on the person's own machine and keeps a Mac awake while it runs.
- The three that matter most for Nightjar, in order: (1) per-criterion proof in the pull request, (2) acting on builds from the page or the phone, (3) a supported always-on mode. Close calls: best-of-N attempts on a hard Ticket, and knowledge that proposes itself after each failure.

## 2. How Nightjar does it today

- **Acceptance criteria are prose.** The Ticket contract only checks that an "Acceptance criteria" heading has a checklist under it (`src/ticket-contract.ts:12-28`). `acceptanceCriteria` cuts them out of a body (`src/ticket-contract.ts:31-45`), and its only caller is the page's detail panel (`src/ui-feature.ts:54-56`). The build Session gets the whole Ticket body (`src/prompt.ts:172-196`). The Review reads the diff against the Feature and its Tickets and is asked about "behaviour the Tickets ask for that nothing verifies" (`src/prompt.ts:534`), but its answer is one verdict and a list of issues, not a verdict per criterion.
- **A reproduce-first Workflow exists, on the agent's word.** The shipped `bug` Workflow tells the Session to write a test, see it fail, fix the code, see it pass, and name the test (`templates/workflows/bug.json:2`; README "Workflows", `README.md:307-319`). The pull request then gets a "Test that shows the bug" section (`src/build.ts:2554-2558`). Nightjar does not run that test on the base itself; it takes the Session's answer.
- **The Coding agent may edit any file, tests included.** A build Session's allow list has `Edit` and `Write` with no path (`src/settings.ts:109-130`). The fixed deny rules (`src/settings.ts:36-62`) block git's writing commands, `gh`, `curl`, `wget`, `ssh`, `scp`, `nc`, reading credentials, `WebFetch` and `WebSearch`. The sandbox lets a command write the worktree and the temp folder (`src/settings.ts:80-91`). Nothing flags a change to a test or to the check that the Ticket did not ask for.
- **A running app, but no evidence.** A Workflow can `serve` the app on a reserved port and give its Steps `localNetwork` (README "Workflows", `README.md:325`; the design-review example at `README.md:263-292`). A Step's output is its commit and a done or not-done line in the pull request's Workflow section (`README.md:337`, `:357`). No screenshot or recording reaches the pull request. On Linux the sandbox's private loopback may not reach `serve` (`README.md:332`).
- **The page only reads.** `nightjar ui` "never puts on a Signal, assigns or comments, and every action stays a link to the Tracker, so the Go is still given in the Tracker alone" (`docs/adr/0009-the-page-reads-the-tracker.md:5`). A running Session is stopped with Ctrl-C at the terminal (`README.md:575`). Nightjar tells a needed person with a new comment on the Tracker (GLOSSARY: Status note); it sends nothing else.
- **It runs on the person's machine.** "Local, single-person tool: runs on macOS, Linux or WSL2 with the person's own `gh`/`az`, `git` and `claude` sign-ins" (`PRODUCT.md:19`). "On macOS, Nightjar keeps the machine awake while it runs" (`README.md:575`). ADR 0005 puts containers out of scope as the sandbox (`docs/adr/0005-every-session-runs-in-the-sandbox-with-no-network.md:17`). Hosted oversight of many people's Queues "is not a goal confirmed here" (`PRODUCT.md:24`).
- **Learning is manual.** A Retro is started by a person, reads the last 30 days of failed Sessions, and proposes a Feature file (README "Learn from failures", `README.md:604-617`). Nothing runs it after a failure.
- **Already there, so not a gap.** Sources include a `sentry` type with a shipped template whose one Ticket is "reproduce the error in a spec, then fix it" (`README.md:428`, `:459-471`; `src/config.ts:217`). Spend per day is capped at $60 or `dailyUsd` (`README.md:636`). The Measures panel shows Autonomy, Time to pull request, Cost per pull request and Sessions by outcome (`README.md:571`).

## 3. Per-tool findings

### Summary table

| Tool | Runtime evidence in the PR | Per-requirement verdict | Act from phone or chat | Runs without your machine | Learns on its own | Best-of-N |
|---|---|---|---|---|---|---|
| GitHub Copilot cloud agent | Screenshots, via a built-in Playwright browser | No | Not checked | Yes, on Actions runners | No | No |
| Cursor cloud agents | Videos, screenshots, logs; optional embed in the PR description | No | Web, desktop, mobile, Slack, GitHub | Yes, isolated VM; self-hosted machines too | Not checked | Not checked |
| OpenAI Codex cloud | No (computer use unsupported in cloud environments, third-party) | No | Mobile, across devices | Yes, cloud containers | No | Yes, `--attempts` 1 to 4 |
| Google Jules | No | No | Pause and steer mid-task | Yes | No | No |
| Devin | Not checked | No | Notification inbox, mobile web, Slack | Yes | Suggests Knowledge; Session Insights | No |
| Factory | No | No | Slack | Yes, on a chosen Droid Computer | Updates an incident runbook | No |
| Augment (internal factory) | Yes, Verifier from E2E tests | No | Not stated | Not stated | Not stated | No |
| Cloudflare / Astro triage | Reproduction, then failing tests | No | No | Yes, in GitHub Actions | No | No |
| Kiro crews | Not stated | No | One dashboard over many machines | Yes, laptops, EC2, Actions, CodeBuild | A memory file every session reads | No |
| Tessl Ticket to PR | Not stated | Yes, "3 of 3 pass" | Not stated | Not stated | No | No |
| **Nightjar** | No (`bug` Workflow names a test) | No | No, Tracker and terminal only | No, the person's machine | Retro, started by a person | No |

### GitHub Copilot cloud agent

- Browser and screenshots: Copilot "now has access to a web browser out of the box, powered by the Playwright MCP server", and "can even share screenshots of what it has done in its pull request" ([changelog 2025-07-02](https://github.blog/changelog/2025-07-02-copilot-coding-agent-now-has-its-own-web-browser/)).
- Environment: setup steps go in `.github/workflows/copilot-setup-steps.yml`, with a job named `copilot-setup-steps`, on the default branch. "By default, Copilot works in a standard GitHub Actions runner"; larger and self-hosted runners are allowed, self-hosted ones should be "ephemeral, single-use", and the built-in firewall "is not compatible with self-hosted runners" ([customize the agent environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment)).
- Session logs: "You can view the agent session logs to understand what Copilot did while working on your task", and custom setup steps' output "now shows in the session logs" ([changelog 2026-03-19](https://github.blog/changelog/2026-03-19-more-visibility-into-copilot-coding-agent-sessions/)). Nightjar's Logbook already covers this, locally.

### Cursor cloud agents

- "Each cloud agent runs in its own isolated VM with a full desktop environment." Agents "use a mouse and keyboard to control the desktop and browser" and check their changes before opening a PR ([capabilities](https://cursor.com/docs/cloud-agent/capabilities)).
- Evidence: screenshots, videos and log references are "attached to the PR so you can quickly validate changes without checking out the branch locally". An opt-in setting, "Allow posting artifacts to GitHub", embeds them in the PR description, behind long unguessable URLs that anyone with the link can open (same page).
- Self-hosted: computer use is available on Self-Hosted Machines, with a worker started with `--computer-use` (same page). The 02-24-26 changelog does not mention self-hosted workers; the capabilities page does.
- Changelog 2026-02-24: "Cloud agents can now use the software they create to test changes and demo their work", and they are "available anywhere you use Cursor, including web, desktop, mobile, Slack, and GitHub" ([changelog 02-24-26](https://cursor.com/changelog/02-24-26)). The blog adds that an agent "recorded itself clicking on buttons to verify they link to the correct source files" ([agent computer use](https://cursor.com/blog/agent-computer-use)).

### OpenAI Codex cloud

- Environments: setup scripts run in their own Bash session with internet; "During the agent phase, internet access is off by default, but you can configure limited or unrestricted access." "Codex caches container state for up to 12 hours"; a maintenance script runs when a cached container resumes ([cloud environment](https://learn.chatgpt.com/docs/environments/cloud-environment); the old developers.openai.com URL redirects there).
- Reusable, cross-device environments: a published environment "lets you reuse that setup for new tasks"; you can select it for a mobile task and "continue the same cloud task across supported devices"; Enterprise can share it with the workspace ([using Codex cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud)). TechCrunch reported the launch at DevDay ([TechCrunch 2026-09-29](https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/)); its claim that computer and browser use are unsupported in cloud environments is third-party only.
- Best-of-N, **confirmed in source**: `codex cloud exec` has `--attempts`, "Number of assistant attempts (best-of-N)", default 1, and "attempts must be between 1 and 4"; `apply` takes `--attempt N` to pick one ([`codex-rs/cloud-tasks/src/cli.rs`](https://github.com/openai/codex/blob/main/codex-rs/cloud-tasks/src/cli.rs)). The first-party docs and help center do not mention it; the write-up at codex.danielvaughan.com is third-party.

### Google Jules

- Critic: "Great developers don't just write code, they question it", built into generation (changelog, 2025-08-08). Planning Critic: "a secondary agent—the Planning Critic—to review all plans that do not require human intervention" (changelog, 2026-01-26) ([changelog](https://jules.google/docs/changelog/)). Nightjar's Preflight and Review cover the same ground, before and after.
- Plan approval, **confirmed**: Interactive Plan, "Jules will now read your codebase, ask clarifying questions, and work with you to refine the plan" (changelog, 2025-08-08); "Once the plan is approved, Jules will start coding" ([running tasks](https://jules.google/docs/running-tasks.md)).
- Environment snapshots, **confirmed**: "Jules now creates a snapshot of your environment when you add environment setup scripts" (changelog, 2025-08-05).
- Steering mid-task: "You can pause Jules at any time"; "You can intervene at any time, you're in control" ([running tasks](https://jules.google/docs/running-tasks.md)).

### Devin

- Knowledge that proposes itself: "Devin will automatically suggest Knowledge to remember based on your feedback in chat", and can suggest updates to existing items; a person edits or dismisses each before it is saved ([knowledge](https://docs.devin.ai/product-guides/knowledge)).
- Session Insights analyses sessions, lists "recommended configuration changes to improve future sessions", rewrites the prompt, and marks Knowledge as helpful or misleading ([session insights](https://docs.devin.ai/product-guides/session-insights)).
- Playbooks "are becoming Skills" (release notes, 2026-10-23); new accounts start with Skills from 2026-10-24 ([creating playbooks](https://docs.devin.ai/product-guides/creating-playbooks), [release notes](https://docs.devin.ai/release-notes/overview)).
- Devin Review groups related changes, shows moved code as a move, and has a Bug Catcher with Bugs, Flags and Security findings, plus Auto-Fix ([Devin Review](https://docs.devin.ai/work-with-devin/devin-review)).
- Reaching people: "Devin now has a notification inbox" (2026-10-07), with a switch per notification type (2026-10-09) and a full-screen view on mobile web (release notes).
- **Unconfirmed:** interactive planning. The docs page returned a tutorial index to the fetcher; a search snippet of it says Devin waits thirty seconds for feedback on its plan before going on. "Advanced mode" was not checked.

### Factory

- Incident Response: an alert that "lands in a configured Slack channel" starts a Droid session; the Droid works toward a root cause, may "open a PR for a fix when appropriate", and can update an incident runbook so "future investigations of the same alert type start faster" ([incident response](https://docs.factory.com/software-factory/incident-response); docs.factory.ai redirects to docs.factory.com).
- Slack: "Tag @Factory and move on"; non-developers describe a problem and get a pull request ([Slack](https://factory.com/product/slack)). The heading says "Slack / Teams", but neither page describes Teams. Automation templates are not on the Slack page; Factory's automations page was cited in `rerun-on-the-board.md`.
- Nightjar's `sentry` Source covers alert to Feature; what it lacks is the runbook that updates itself.

### Augment (its own factory)

- A first-party blog post, not product docs (2026-09-11). "Risk Analyzer auto-approves low-risk PRs; Deep Reviewer posts comments for objective bugs"; "Pair Reviewer creates Design & Architecture report"; "Verifier generates runtime evidence (screenshots, logs, etc.) from E2E testing". Their value "came from gathering inspectable runtime evidence, not from producing plausible explanations based only on code" ([Augment's software factory](https://www.augmentcode.com/blog/beyond-ai-coding-agents-how-we-built-augments-software-factory)).
- ROI: median time to merge fell from 11.2 to 3.1 hours, and the 14-day revert rate from 1.9% to 0.4%, which the authors call "a longitudinal case study, not a controlled experiment" (same post).

### Cloudflare and Astro issue triage

- "The whole pipeline was really just a state machine driven by issue labels." The skill first reproduces the bug, then turns the reproduction into "failing unit tests" before the fix, and runs "right inside GitHub Actions", now as `triagebot-action` ([Cloudflare blog, 2026-08-04](https://blog.cloudflare.com/astro-issue-triage/)).
- Nightjar's Signals and `bug` Workflow match this. The difference is that it runs on Actions, not on a laptop.

### Kiro crews

- First-party blog (2026-09-18): "I actually run six to ten machines at once, all linked from a single dashboard." A memory file is "a file in the repo that every session reads, holding your conventions and the corrections you keep repeating." Stages "coordinate only through a message queue." "Today our crews run on laptops, on EC2 instances, on cloud dev desktops", and handed-off jobs "also run on GitHub Actions and CodeBuild" ([1000 PRs](https://kiro.dev/blog/software-factory-1000-prs/)).

### Tessl Ticket to PR

- A product page, mocked up. Verifiers check the result against separate requirements ("Form fields come from the design system", "No raw hex values"), and show "3 of 3 pass" for one ticket; the PR shows "Code Review and Verifiers passed" ([Ticket to PR](https://tessl.io/ticket-to-pr)). The page shows no failing verifier, so how a failure looks is not documented.

## 4. Patterns

1. **Show, do not tell.** Copilot, Cursor and Augment put what the running app did into the pull request. Tessl gives one verdict per requirement. Cloudflare and Nightjar's `bug` Workflow make a failing test first. Nobody documents running that test on the base branch to prove it fails there.
2. **The person acts where they are.** Pause and steer (Jules), mobile and Slack (Cursor, Codex, Devin, Factory), an inbox (Devin). Each acts on the tool's own record of the task. Nightjar's record is the Tracker, so the page would have to write through the Adapter.
3. **The factory does not live on a laptop.** Every hosted tool runs in its own machine; Copilot and Cloudflare reuse GitHub Actions; Kiro runs the same crews on laptops and on EC2.
4. **Learning is suggested, then approved.** Devin suggests Knowledge and a person keeps it; Factory updates a runbook. Nightjar's Retro already ends in a Feature a person approves; it is just never started for them.
5. **Several tries.** Only Codex documents best-of-N, in its CLI source.

## 5. The three gaps that matter most

Facts are cited above; this section is opinion. Each item is a candidate for a `/grill-with-docs` session, not a decision.

1. **Proof in the pull request that it works.** Give each acceptance criterion a verdict with its evidence: a screenshot or recording from the `serve`d app, or a test that Nightjar itself runs and sees fail on the base and pass on the branch (today the `bug` Workflow takes the Session's word). Show the verdicts in the pull request and on the Board. Flag edits to tests or the check that the Ticket did not ask for, since the Coding agent may edit any file in the worktree. Why first: Nightjar's promise is a pull request a person can trust after a short read, and the field (Copilot, Cursor, Augment, Tessl) has moved from "the check passed" to "here is what it did". The Linux loopback limit on `localNetwork` must be solved for screenshots to work there.
2. **Act on builds from the page or the phone, not only the Tracker.** Answer needs info inline, give or take back the Go, stop or pause a build, and build a Ticket again, all written through the Adapter so the Tracker stays the record. Optionally, a push or Slack message only when a person is needed. This reopens ADR 0009, which keeps the page read-only, and touches ADR 0003, which keeps the Go in one place.
3. **Keep building while the laptop is closed.** A supported always-on mode: an image or a GitHub Actions workflow that runs `nightjar --watch` with bubblewrap, documented sign-ins for `gh`, `az` and `claude`, and a "factory alive" sign on the page. This conflicts with `PRODUCT.md`'s "local, single-person tool" and needs ADR 0005's sandbox to hold on a runner.

Close calls:

- **Best-of-N on a hard Ticket.** Codex's `--attempts` 1 to 4 is the only documented case. It multiplies spend against `dailyUsd`, and Nightjar would need a rule to pick the winner (the check, then the Review).
- **Knowledge that saves itself.** Start a Retro on its own after a failed or handed-back Session, as Devin suggests Knowledge and Factory updates its runbook; a person still approves the Feature it makes.
- **Features from production errors** was on the list, but Nightjar already has it: the `sentry` Source and its shipped template (`README.md:459-471`).

## 6. Sources (all read 2026-11-27)

- Nightjar: `src/ticket-contract.ts`, `src/ui-feature.ts`, `src/prompt.ts`, `src/settings.ts`, `src/build.ts`, `src/config.ts`, `templates/workflows/bug.json`, `README.md`, `PRODUCT.md`, `GLOSSARY.md`, `docs/adr/0005-every-session-runs-in-the-sandbox-with-no-network.md`, `docs/adr/0009-the-page-reads-the-tracker.md`
- GitHub Copilot: [changelog 2025-07-02, web browser](https://github.blog/changelog/2025-07-02-copilot-coding-agent-now-has-its-own-web-browser/); [customize the agent environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment); [changelog 2026-03-19, session visibility](https://github.blog/changelog/2026-03-19-more-visibility-into-copilot-coding-agent-sessions/)
- Cursor: [cloud agent capabilities](https://cursor.com/docs/cloud-agent/capabilities); [agent computer use](https://cursor.com/blog/agent-computer-use); [changelog 02-24-26](https://cursor.com/changelog/02-24-26)
- OpenAI Codex: [cloud environment](https://learn.chatgpt.com/docs/environments/cloud-environment); [using Codex cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud); [`cloud-tasks/src/cli.rs`](https://github.com/openai/codex/blob/main/codex-rs/cloud-tasks/src/cli.rs); third-party: [TechCrunch 2026-09-29](https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/), [codex.danielvaughan.com on best-of-N](https://codex.danielvaughan.com/2026/04/01/codex-cloud-exec-best-of-n-attempts/)
- Google Jules: [changelog](https://jules.google/docs/changelog/); [running tasks](https://jules.google/docs/running-tasks.md)
- Devin: [release notes](https://docs.devin.ai/release-notes/overview); [knowledge](https://docs.devin.ai/product-guides/knowledge); [session insights](https://docs.devin.ai/product-guides/session-insights); [creating playbooks](https://docs.devin.ai/product-guides/creating-playbooks); [Devin Review](https://docs.devin.ai/work-with-devin/devin-review); [interactive planning](https://docs.devin.ai/work-with-devin/interactive-planning) (not readable, see above)
- Factory: [incident response](https://docs.factory.com/software-factory/incident-response); [Slack](https://factory.com/product/slack)
- Augment: [beyond AI coding agents](https://www.augmentcode.com/blog/beyond-ai-coding-agents-how-we-built-augments-software-factory)
- Cloudflare: [Astro issue triage](https://blog.cloudflare.com/astro-issue-triage/)
- Kiro: [software factory, 1000 PRs](https://kiro.dev/blog/software-factory-1000-prs/)
- Tessl: [Ticket to PR](https://tessl.io/ticket-to-pr)
