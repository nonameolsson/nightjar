# Every Session runs in the sandbox, with no network

Nightjar keeps the Coding agent in check with permission rules, but those rules match command names, not what a command does. Anything in `allowedCommands` (`npm test`, `make *`) runs scripts from the branch, and a script can reach the network and read the home folder: `~/.ssh`, the `gh` token, cloud credentials. So the sandbox is part of the deny rules, and a Workflow can never loosen it, like the rest of `src/settings.ts`.

Every Session that runs the Coding agent runs in Claude Code's OS sandbox (Seatbelt on macOS, bubblewrap on Linux and WSL2): build Sessions and their fix rounds, Steps and their fix rounds, the review, Pull-check fixes, and any Session kind added later. `setup`, the check and a Workflow's `serve` stay outside it, because Nightjar runs them, not the agent.

- **No network.** A sandboxed Session reaches nothing. A Step of a `localNetwork` Workflow reaches localhost and nothing else. No key in `factory.json` opens the network to the agent, not even a list of allowed domains, so an install belongs in `setup`, not in `allowedCommands`.
- **Writes go only to the worktree and the temp folder.** No `factory.json` key adds a writable path.
- **Credential paths cannot be read.** One shared list in `src/settings.ts` is denied to sandboxed commands and to the Read tool. No `factory.json` key removes a path from it or adds a readable one.
- **It fails closed.** A machine that cannot sandbox gets no build, and no flag opts out. Running the agent unsandboxed would turn the guarantee into a hope.
- **No hooks.** Hooks run outside the sandbox with full access, so a Session's settings turn them all off.

## Considered Options

- **Let `factory.json` list allowed domains, such as package registries.** Rejected: any reachable host can carry data out, and a repo's own `factory.json` would then decide how far the agent reaches. Installs move to `setup`, which Nightjar runs outside the sandbox.
- **Fail open when the sandbox is unavailable.** Rejected: a build would silently run with the whole home folder readable on the machines least able to say so.
- **Containers (Docker, Podman, cloud sandboxes).** Out of scope: the OS sandbox needs nothing installed beyond `bubblewrap` and `socat` on Linux, and Nightjar names no sandbox provider.
