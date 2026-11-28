---
name: nightjar-setup
description: Set up Nightjar in this repo: write `factory.json`, create the Signal labels and check the logins, through `nightjar init`. Use when the repo has no `factory.json`, when asked to install, set up, configure or onboard Nightjar, or when `nightjar doctor` fails on `factory.json` or a login.
---

# Set up Nightjar in this repo

Get this repo from no `factory.json` to a green `nightjar doctor`, by running `nightjar init` with the answers as flags. `init` writes the file, creates the Signal labels and checks the logins; this skill finds the answers and reports what is left for the person.

## 1. Find the CLI and the state

Run `nightjar --version`. If it is not on the PATH, try `npx @nonameolsson/nightjar --version`, and use whichever answers as `nightjar` below. If neither runs, tell the person to install Node 24 and `npm i -g @nonameolsson/nightjar`, and stop.

Then look for `factory.json` at the repo's root.

- **It exists:** `init` keeps it, asks nothing, and only creates the labels and checks the logins. Run `nightjar init` once, then go to step 4.
- **It is missing:** go on to step 2.

## 2. Work out the answers

Ask the person only for what the repo cannot tell you. Offer each recommendation with its evidence.

- **Tracker and Code host.** Read `git remote get-url origin`. A `github.com` remote means `github` for both and `init` offers the `owner/name` itself. A `dev.azure.com` or `visualstudio.com` remote means `azure-devops`: ask for the organization and project (and the Feature type, and the Ticket type if they want `nightjar create`). A Tracker that is not the Code host, or one of the person's own, takes `--tracker module --tracker-path PATH`; see "Another Tracker or Code host" in the Nightjar README.
- **Check command.** The one command that must pass before any Ticket is a commit: read `CLAUDE.md`, `AGENTS.md`, the `package.json` scripts, the `Makefile`, `mise.toml` and `.github/workflows/`, and take what CI runs. Run it once to see that it passes now. It must be able to fail: never `true`.
- **Allowed commands.** What the Coding agent may run without asking: the check command, and the test, lint and build commands you found, comma separated. An install (`npm install`, `pip install`) cannot fetch anything in a Session and belongs in `setup`, so leave it out. `none` is allowed.

Done when you hold a value for each flag you will pass, and have run the check command yourself.

## 3. Run `init`

Say the command you will run, then run it:

```bash
nightjar init --yes --check 'npm run check' --allowed-commands 'npm test,npm run lint'
```

Add `--tracker`, `--code-host` and their `--tracker-` and `--code-host-` fields (`repo`, `organization`, `project`, `path`, and on the Tracker `feature-type` and `ticket-type`) only where the defaults are wrong. A value with no default and no flag stops `init` before it writes anything and names the flag to pass: pass it and run again.

Read the whole output. `init` runs the repo's check once and checks each login: it ends `ok`, or names what fails.

Do not run `gh auth login`, `az login` or `claude auth login` for the person: each is interactive and signs in as them. Give them the command `init` printed and ask them to run it (in Claude Code, `! gh auth login` runs it in this session), then run `nightjar init` again, which only rechecks.

Done when `init` has written `factory.json` and every login line is `ok`.

## 4. Verify and finish

1. Run `nightjar doctor` and read each line. Fix a `FAIL` you can (a missing `.factory/` in `.gitignore`: add the line); report one you cannot, such as the `sandbox` line on Linux, which needs `bubblewrap` and `socat` installed by the person.
2. If `.gitignore` lacks `.factory/`, add it.
3. Tell the person what changed: `factory.json` and `.gitignore`, to commit, and the labels created on the Tracker. Do not commit or push unless they ask.
4. Give the next step: assign a Feature to yourself on the Tracker, give it the Go (the `factory-go` label on GitHub), then run `nightjar --once` or `nightjar --watch`. To write a Feature from an idea, the `nightjar-feature` skill does it.

Done when `nightjar doctor` has no `FAIL`, or each one left is named to the person with who must fix it.
