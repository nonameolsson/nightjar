# Building a Queue of Features while earlier pull requests are unmerged

Research note, read 2026-11-20. Every source below was read on that date.

## 1. Question and short answer

How do autonomous coding agents and stacking or merge-queue tools handle several features built one after another while earlier pull requests are still open? Do they branch from the default branch, stack on unmerged work, rebase or merge when the base moves, and how do they handle dependencies and conflicts? What branching standards should Nightjar follow?

Short answer:

- Every cloud agent checked (Copilot, Codex, Jules, Cursor, Factory, Claude Code Action) starts each task on a fresh branch from one base, the default branch unless a person picks another. None documents chaining one task onto another task's unmerged branch.
- Only Devin stacks, and only inside one session that split one piece of work on purpose. It uses GitHub's native stacked pull requests, generally available since 2026-10-06.
- Conflicts are fixed on request, not by default: Copilot resolves them when asked or under Agent Merge, and Devin fixes conflicts inside its own stacks. None documents rebasing open PRs on its own when main moves.
- Standards agree: short-lived branches off trunk, integrate one at a time, re-sync the rest to trunk after each lands; a merge queue makes "up to date" unnecessary for authors. Stacking is the accepted tool for dependent changes.
- Nightjar's branch-from-main default matches the field. Its gap is dependent Features: today a blocked Feature is built partly and stops; it could instead wait (opinion: do this first), then optionally stack later.

## 2. How Nightjar does it today

- **Branch name.** `BRANCH_PREFIX = 'factory/'` (`src/worktree.ts:32`). `branchFor(id, title)` gives `factory/<id>-<slug>`, the slug lowercased, non-alphanumerics to `-`, cut to 40 characters (`src/worktree.ts:37-45`).
- **Base.** The base branch is `origin/HEAD`'s target, else `main` (`src/checks.ts:501`, `defaultBranch` at `src/worktree.ts:434-437`). `openWorktree` fetches `origin/<base>` and the Feature's own remote branch (`src/worktree.ts:407-412`). It reuses an existing worktree after a hard reset and clean (`:417-420`), else the local branch (`:423-424`), else the pushed branch (`:425-426`), and only otherwise branches from `origin/<base>` (`:428`). A reused branch is never rebased or merged with the moved base.
- **Pull request base.** The draft always targets the base branch (`src/build.ts:971-975`). On GitHub each Ticket reference becomes `Closes #N`, so Tickets close when the PR merges (`src/github/code-host.ts:181-182`).
- **Queue.** `queue` takes `assignedFeatures(person)[0]`, the oldest Feature with the Go (`src/queue.ts:446-453`; ordering contract `src/tracker.ts:101`). Building removes the Go (`src/build.ts:233`), so the next poll takes the next Feature. Nothing looks at open PRs of earlier Features when picking or branching. Nightjar never stacks a Feature on another Feature's branch.
- **Dependencies.** Only Ticket-level: a Ticket is buildable when every blocker is closed or built on this branch (`src/plan.ts:5-12`). A Ticket blocked by a Ticket of another, unmerged Feature stays open (it closes on merge), so it waits as "blocked by #N" (`src/plan.ts:40-41`). The Feature is built up to that Ticket and its draft PR opened with the rest listed as waiting. There is no Feature-level "blocked by" and no hold.
- **Main moving.** No code updates a Feature branch from main. `toRemote` only fast-forwards a local branch to its own pushed branch (`src/worktree.ts:322-341`). Nothing reads mergeability or conflicts (no `mergeable` or `conflict` anywhere in `src/`).
- **`src/stale.ts` is not about Feature branches.** It is the idle `--watch` check for newer Nightjar code: for a linked checkout it fetches `origin main` of the Nightjar checkout and reports whether `origin/main` is ahead of the commit the run started on; for an install it compares installed and published npm versions (`src/stale.ts:72-92`; wired only for `--watch` at `src/main.ts:289`; used by `warnIfStale` at `src/queue.ts:403-413`). It only warns; it never touches a Feature.
- **Already decided.** ADR 0004 makes Nightjar fix red Pull checks on its own drafts until a person engages, and rejects pushing once a person engages: "pushes under a person's review move the code they are reading" (`docs/adr/0004-nightjar-fixes-pull-checks-until-a-person-engages.md`). It also rejects waiting on Pull checks inside a run because it would stall the Queue. ADR 0002 forbids reading or writing tracker states, so any "blocked" hold must come from links or Signals, not states.

## 3. Per-product findings

### Summary table

| Product | Branches from | Prefix | Stacks on unmerged work | Updates PR when base moves | Conflicts | Cross-task dependencies |
|---|---|---|---|---|---|---|
| GitHub Copilot cloud (coding) agent | The base a person picks; a new branch per task | `copilot/` | No (one branch, one PR per task) | Not documented as automatic | On request ("@copilot resolve the merge conflicts") or Agent Merge | Not documented |
| OpenAI Codex cloud | Not documented | Not documented (`codex/` seen only in forum posts) | Not documented | Not documented | Not documented | Not documented |
| Google Jules | The branch a person picks (`starting_branch`, default `main`, in the Action) | Not documented | Not documented | Not documented | Not documented | Not documented |
| Devin | Trunk for the bottom PR | Not documented | Yes, inside one session, via GitHub native stacks | Watches the stack; method not documented | Resolves silently; asks only for real decisions | Only within its own stack |
| Cursor cloud agents | Dashboard base branch, else default branch; API `startingRef` | `cursor/` | Not documented | Not documented | Not documented | Not documented |
| Factory (Droids) | Selected base branch (worktrees) | Not documented | Not documented | Not documented | Not documented | Not documented |
| Sweep | Default branch, or `branch:` line in the issue | Not documented | No | Proposed switch from merge to rebase (unmerged PR) | Proposed: close the PR on conflict | Not documented |
| Claude Code GitHub Action | `base_branch` input, else default branch | `claude/` (`branch_prefix`) | No | No | No | No |

### GitHub Copilot cloud agent (formerly coding agent)

- One task, one branch, one PR: "Copilot can only work on one branch at a time and can open one pull request per task." ([about](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent))
- Base: "Copilot will create a new branch based on the selected branch and push its changes to a pull request targeting that branch." ([changelog 2025-07-23](https://github.blog/changelog/2025-07-23-agents-page-set-the-base-branch-for-github-copilot-coding-agent-tasks/))
- Prefix: "a new `copilot/` branch is created for Copilot, and the agent can only push to that branch"; when @mentioned on an existing PR it has write access to that PR's branch. ([risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations))
- Follow-up on an existing PR pushes to that PR's branch by default; a separate PR only if asked. ([make changes to an existing PR](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr))
- Conflicts: on request ("@copilot Merge in main and resolve the conflicts"), with build and tests re-run before pushing ([changelog 2026-03-26](https://github.blog/changelog/2026-03-26-ask-copilot-to-resolve-merge-conflicts-on-pull-requests/)). Agent Merge watches a PR and fixes selected blockers: "resolve merge conflicts", failing Actions, or both; it pairs with auto-merge rather than merging itself ([changelog 2026-10-28](https://github.blog/changelog/2026-10-28-agent-merge-watches-and-fixes-pull-requests-in-the-cloud)). Merge vs rebase for these: not documented.
- Dependencies between tasks: not documented.

### OpenAI Codex cloud

- Docs say only that you "commit or open a pull request when you're ready" and that each task keeps "its own working state". Base branch, naming, updates and conflicts: not documented ([Codex cloud](https://learn.chatgpt.com/docs/cloud); [GitHub integration](https://learn.chatgpt.com/docs/third-party/github), which covers `@codex review` only).
- The `codex/` prefix appears only in user forum posts, not in first-party docs, so it is not a sourced fact here.

### Google Jules

- "Choose the branch you want to base your changes on." then "Create branch"/"Publish branch"/"Publish PR" ([running tasks](https://jules.google/docs/running-tasks.md), [reviewing code](https://jules.google/docs/code/)).
- The GitHub Action's `starting_branch`: "Branch for Jules to start from.", default `main` ([jules-action](https://github.com/google-labs-code/jules-action)).
- Naming, updating a PR, conflicts, dependencies: not documented.

### Devin

- Stacks only when "it has intentionally decomposed one piece of work into an ordered series of PRs". Bottom PR targets trunk; each higher PR's base is "the head branch of the PR below it". Built on GitHub native stacks, 2 to 100 PRs, GitHub.com only ([stacked PRs](https://docs.devin.ai/work-with-devin/stacked-prs)).
- Conflicts arise when "review feedback lands on a lower layer" or "the trunk moves underneath the stack"; Devin resolves them and asks only when a conflict "reflects a substantive decision that needs your input". When lower PRs merge, GitHub retargets the rest. Rebase vs merge: not documented (same page).
- Merging a PR merges every open PR below it "atomically, in a single operation"; regular GitHub merge is not available for stacked PRs (same page).
- Dependencies across separate sessions: not documented.

### Cursor cloud agents (formerly background agents)

- Base branch setting: "the branch agents fork from when creating pull requests. Leave blank to use the repository's default branch." ([settings](https://cursor.com/docs/cloud-agent/settings))
- API: `startingRef` is the start point; by default "Cursor pushes commits to a new auto-generated branch (`cursor/...`)"; `workOnCurrentBranch: true` pushes to the starting ref; `prUrl` works on that PR's branches; `autoCreatePR` opens a PR at the end ([API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints)).
- Updating on base moves, conflicts, dependencies: not documented.

### Factory.ai (Droids)

- Worktrees: base branch is "The branch Factory uses as the starting point for a new worktree"; it "creates a new branch from it" ([worktrees](https://docs.factory.com/factory-app/worktrees)).
- Automations land "one small maintenance PR per run"; a run is skipped when "a previous run was still in progress" ([automations](https://docs.factory.com/software-factory/automations)).
- Naming, conflicts, stacking, dependencies: not documented.

### Sweep

- Base per issue via a `branch: BRANCH_NAME` line in the issue ([advanced usage](https://github.com/sweepai/sweep/blob/76aecb2fabb654a5ee14199f95797b5e3bbee04e/docs/pages/usage/advanced.mdx)).
- A 2024 PR proposed: "Instead of merging the default branch into feature branches, it now attempts to rebase", and "If a conflict occurs, the pull request is closed." It is still open, not merged, so this was never shipped behaviour ([sweepai/sweep#3455](https://github.com/sweepai/sweep/pull/3455)).

### Claude Code GitHub Actions

- `branch_prefix`: "The prefix to use for Claude branches (defaults to 'claude/'...)"; `base_branch`: "The base branch to use for creating new branches" ([usage.md](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md)).
- Source: an open PR checks out the PR's head branch; an issue or closed/merged PR gets a new branch from `base_branch` or the repo's default ([branch.ts](https://raw.githubusercontent.com/anthropics/claude-code-action/main/src/github/operations/branch.ts)). Default name `${branchPrefix}${entityType}-${entityNumber}-${timestamp}`, lowercased, cut to 50 characters ([branch-template.ts](https://raw.githubusercontent.com/anthropics/claude-code-action/main/src/utils/branch-template.ts)).
- No stacking, updating or conflict handling in the action itself.

### Stacking tools

- **GitHub native stacked PRs.** GA 2026-10-06 on all github.com plans ([changelog](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available)). Bottom PR targets trunk; "Each subsequent pull request targets the branch of the pull request below it." When the bottom merges, "the remaining branches are automatically rebased so the next pull request targets the default base branch". Stacks are "merge-queue aware"; REST "provides endpoints to list, create, extend, and dissolve stacks" ([about stacked PRs](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)). A stack "enters and lands through the merge queue as a single merge group"; a deleted base branch makes GitHub retarget the stack (GA changelog). CLI `gh stack sync` cascade-rebases "only if trunk moved" and pushes with `--force-with-lease`; on conflict it restores all branches ([CLI reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands)).
- **Plain GitHub retargeting.** Since 2020, when a PR's head branch is merged and deleted, PRs based on it are retargeted to the merged PR's base instead of closed ([changelog 2020-05-19](https://github.blog/changelog/2020-05-19-pull-request-retargeting)). Changing a base by hand can drop commits from the timeline and outdate review comments ([changing the base branch](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-base-branch-of-a-pull-request)).
- **Graphite.** `gt restack` "ensures that all branches are based on the current version of their parents"; after a parent is squash-merged, restack moves children onto the new `main`; conflicts pause for `gt continue`/`gt abort` ([restack](https://graphite.com/docs/restack-branches)).
- **ghstack.** One PR per commit, each on `gh/<user>/<N>/head` into `gh/<user>/<N>/base`; PRs do not target main, so land with `ghstack land`; rebase onto upstream rather than merge ([README](https://github.com/ezyang/ghstack)).
- **git-town.** `sync --stack` syncs every branch in the stack and drops commits of deleted (shipped) parents from descendants ([sync](https://www.git-town.com/commands/sync)). `sync-feature-strategy`: `merge` is the default as "the safest and easiest option"; `rebase` force-pushes with `--force-with-lease --force-if-includes`; `compress` squashes to one commit ([strategy](https://www.git-town.com/preferences/sync-feature-strategy)).
- **Sapling.** `sl pr submit --stack` makes one PR per commit; they are "overlapping" and "will not look right" on GitHub, so ReviewStack is recommended ([Sapling stack](https://sapling-scm.com/docs/git/sapling-stack)).
- **Aviator `av`.** `av sync` rebases each branch onto its parent; `--rebase-to-trunk` rebases the whole stack on trunk; `av pr` sets a child PR's base to its parent branch ([av CLI](https://docs.aviator.co/aviator-cli)).
- **`git rebase --update-refs`.** "Automatically force-update any branches that point to commits that are being rebased. Any branches that are checked out in a worktree are not updated in this way." `rebase.updateRefs` turns it on by default ([git-rebase](https://git-scm.com/docs/git-rebase)). The worktree caveat matters for Nightjar, which keeps each Feature in its own worktree.

### Merge queues

- **GitHub merge queue.** Builds a `merge_group` on the latest base plus the PRs ahead; third-party CI must run on `gh-readonly-queue/{base_branch}`; Actions need the `merge_group` trigger; a failing or conflicting PR is removed and the rest re-run; it "does not require a pull request author to update their pull request branch" ([managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
- **GitLab merge trains.** Each MR is tested "against the combined changes of every merge request ahead of it"; a failed MR is dropped and later ones re-run; default 20 parallel pipelines; a conflicted MR is fixed by rebasing on the target and re-adding ([merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/)).
- **Mergify.** Speculative checks and batches ([merge queue](https://docs.mergify.com/merge-queue/)). `Depends-On: #123` (or URL, or `org/repo#123`) in a PR body blocks merging "until specified pull requests are merged"; cycles never resolve; at most 50 ([built-in protections](https://docs.mergify.com/merge-protections/builtin/)). Its own stacks queue every member "against the stack root (e.g. `main`), not its immediate parent branch" ([stacks](https://docs.mergify.com/merge-queue/stacks)).
- **Bors / Aviator.** bors-ng is in maintenance: "use GitHub's built-in merge queue"; it batched PRs on a `staging` branch and bisected failures ([bors-ng](https://github.com/bors-ng/bors-ng)). Aviator MergeQueue "tests the pull request against the latest changes in the target branch" and removes a failing PR ([MergeQueue](https://docs.aviator.co/mergequeue)).

## 4. Best practices and standards

- **Trunk-based development.** One trunk; "short-lived feature branches are used for code-review and build checking (CI)"; PR workflows are fine "as long as those feature branches are short-lived"; at scale, "merge/patch queues" ([trunkbaseddevelopment.com](https://trunkbaseddevelopment.com/)).
- **Short-lived branches.** "the branch should only last a couple of days"; "Time spent waiting for review counts towards the branch's short life." The page now covers agents: the unit is "one developer and their coding agents"; each agent session is a short-lived branch under the same rules; integrate agents' work one at a time and re-sync the others to trunk after each lands. Merging one in-flight branch into another breaks the contract ([short-lived feature branches](https://trunkbaseddevelopment.com/short-lived-feature-branches/)). Note: that last rule is about merges, not about a PR based on another branch.
- **Updating a PR.** GitHub offers both: **Update branch** merges base into head; **Update with rebase** gives linear history ([keeping your PR in sync](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/keeping-your-pull-request-in-sync-with-the-base-branch)). Strict required checks make a branch be up to date before merge; loose ones warn checks "may fail after you merge" ([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)). A merge queue removes the need for authors to update (above). Tools that rebase use `--force-with-lease` (gh stack, git-town). git-town defaults to merge as safest.
- **Stacked diffs.** The accepted way to ship dependent changes before the first merges: child PR based on parent branch, cascade rebase when the parent changes, retarget to trunk when it merges (GitHub stacks, Graphite, av, ghstack).
- **Branch naming.** Conventional Branch 1.1.0: `<type>/<description>`, lowercase `a-z0-9`, hyphens and dots; description "SHOULD include the ticket number" (e.g. `feature/issue-123-new-login`). v1.1.0 adds agent prefixes `ai/`, `claude/`, `codex/`, `copilot/`, `cursor/`; other prefixes are a documented team extension; `unknown/some-task` is invalid ([conventionalbranch.org](https://conventionalbranch.org/)). Agents in practice use a tool prefix: `copilot/`, `cursor/`, `claude/<entity>-<n>-<timestamp>`.

## 5. Options for Nightjar

Facts are cited above; everything in this section is opinion unless marked.

**A. Stay branch-from-main; wait for merge (today).**
Simple, matches every cloud agent (fact, section 3), and keeps PRs independent and reviewable in any order. Cost: a Feature that needs an unmerged Feature is built only up to the blocked Ticket, and its PR is partial.

**B. Hold a Feature whose Tickets are blocked by another Feature's unmerged Ticket.**
Before building, if the first buildable Ticket cannot be reached because its blocker belongs to another open Feature, skip to the next Feature in the Queue and keep the Go. Uses the Ticket links Nightjar already reads (`src/plan.ts`); no tracker state (ADR 0002). Cost: the Feature waits for a person to merge; needs a clear "waiting on #N" in the Board and a Feature-level read of blockers. Mergify's `Depends-On` is the same idea at PR level (fact).

**C. Stack on the predecessor's branch; PR base = predecessor branch; retarget on merge.**
Unblocks work fast; GitHub now supports this natively with REST endpoints and retargets on merge (fact). Costs: Nightjar must rebase the child when the parent gets Feedback rounds or Pull-check fixes, which ADR 0004 already limits once a person engages; a cascade rebase force-pushes under a reviewer; Azure Repos has no equivalent here (not researched); `git rebase --update-refs` skips branches checked out in other worktrees (fact), and Nightjar uses one worktree per Feature. Devin limits stacking to work one session split on purpose (fact); Nightjar's Features are separate items with separate Go's.

**D. Update open drafts when main moves.**
Merge main into a stale draft (no force-push, safe for reviewers; GitHub's default **Update branch**, git-town's default) or rebase (linear, but rewrites what a reviewer read). Only before a person engages, by ADR 0004's reasoning. Conflicts would need a Session and could fail. A merge queue makes this unnecessary for merge correctness (fact); it helps only for keeping Pull checks meaningful and showing conflicts early. Cheaper first step: report a conflicted draft (GitHub `mergeable`) as Feedback-like work or a needs-a-person Signal.

**E. Branch naming.**
`factory/<id>-<slug>` already matches the agent pattern (tool prefix plus ticket number plus slug). It is not a Conventional Branch 1.1.0 type: `factory/` is not in the list, and `refPart` keeps uppercase letters in the id (`src/worktree.ts:35`) while the spec requires lowercase. Options: keep it (a team extension is allowed by the spec, fact), or lowercase the id part. Switching to `ai/` would break `openPulls('factory/')` and existing branches.

**Recommendation (opinion).** Keep A as the default and add B: hold a Feature whose next Ticket is blocked by another open Feature's Ticket, skip to the next Feature, and show why. It removes partial PRs with little new machinery and no force-pushes. Defer C until GitHub stacks have been used for a while and there is a Code-host-neutral plan, and add D only as "merge main into an untouched draft" behind a config flag, with conflicts handed to a person. Keep `factory/`; consider lowercasing the id. Each of B, C and D is a decision worth an ADR.

## 6. Sources (all read 2026-11-20)

- GitHub Copilot: [about coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent); [risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations); [make changes to an existing PR](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr); [changelog 2025-07-23 base branch](https://github.blog/changelog/2025-07-23-agents-page-set-the-base-branch-for-github-copilot-coding-agent-tasks/); [changelog 2026-03-26 resolve conflicts](https://github.blog/changelog/2026-03-26-ask-copilot-to-resolve-merge-conflicts-on-pull-requests/); [changelog 2026-10-28 Agent Merge](https://github.blog/changelog/2026-10-28-agent-merge-watches-and-fixes-pull-requests-in-the-cloud)
- OpenAI Codex: [Codex cloud](https://learn.chatgpt.com/docs/cloud); [GitHub integration](https://learn.chatgpt.com/docs/third-party/github)
- Google Jules: [running tasks](https://jules.google/docs/running-tasks.md); [reviewing code](https://jules.google/docs/code/); [jules-action](https://github.com/google-labs-code/jules-action)
- Devin: [stacked PRs](https://docs.devin.ai/work-with-devin/stacked-prs)
- Cursor: [cloud agent settings](https://cursor.com/docs/cloud-agent/settings); [API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints)
- Factory: [worktrees](https://docs.factory.com/factory-app/worktrees); [automations](https://docs.factory.com/software-factory/automations)
- Sweep: [advanced usage](https://github.com/sweepai/sweep/blob/76aecb2fabb654a5ee14199f95797b5e3bbee04e/docs/pages/usage/advanced.mdx); [PR #3455](https://github.com/sweepai/sweep/pull/3455)
- Claude Code Action: [docs](https://code.claude.com/docs/en/github-actions); [usage.md](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md); [branch.ts](https://raw.githubusercontent.com/anthropics/claude-code-action/main/src/github/operations/branch.ts); [branch-template.ts](https://raw.githubusercontent.com/anthropics/claude-code-action/main/src/utils/branch-template.ts)
- GitHub stacks and PRs: [stacked PRs GA](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available); [about stacked PRs](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs); [gh stack CLI](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands); [retargeting 2020](https://github.blog/changelog/2020-05-19-pull-request-retargeting); [changing the base branch](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-base-branch-of-a-pull-request); [keeping a PR in sync](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/keeping-your-pull-request-in-sync-with-the-base-branch); [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches); [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- Stacking tools: [Graphite restack](https://graphite.com/docs/restack-branches); [ghstack](https://github.com/ezyang/ghstack); [git-town sync](https://www.git-town.com/commands/sync); [git-town sync-feature-strategy](https://www.git-town.com/preferences/sync-feature-strategy); [Sapling stack](https://sapling-scm.com/docs/git/sapling-stack); [Aviator av CLI](https://docs.aviator.co/aviator-cli); [git-rebase](https://git-scm.com/docs/git-rebase)
- Merge queues: [GitLab merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/); [Mergify merge queue](https://docs.mergify.com/merge-queue/); [Mergify stacks](https://docs.mergify.com/merge-queue/stacks); [Mergify built-in protections](https://docs.mergify.com/merge-protections/builtin/); [bors-ng](https://github.com/bors-ng/bors-ng); [Aviator MergeQueue](https://docs.aviator.co/mergequeue)
- Standards: [trunkbaseddevelopment.com](https://trunkbaseddevelopment.com/); [short-lived feature branches](https://trunkbaseddevelopment.com/short-lived-feature-branches/); [Conventional Branch 1.1.0](https://conventionalbranch.org/)
