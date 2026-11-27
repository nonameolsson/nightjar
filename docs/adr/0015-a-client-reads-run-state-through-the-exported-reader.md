# A client reads a repo's run state through the exported reader

An outside client on the same machine wants to show a repo's builds beside `nightjar ui` (#396). It reads Features, Tickets and Signals from the Tracker itself and gives the Go there (docs/adr/0003, docs/adr/0009), so it asks Nightjar only for the run state, which lives nowhere but `.factory/`: whether a run is alive, each Slot's Session and its tail, spend, and completed builds. Nightjar now exports the reader the page already uses, `readFactory`, as a package subpath of its own, `nightjar/run`. It holds a narrower public view projected from `FactoryView`, the reader, and `watchRun(root, onChange)`, the page's `.factory/` watcher lifted out of `src/ui.ts` and used by the page too. Reading works with nothing running, a client learns of a change within about a second, and the page and a client cannot drift, because one reader serves both. Nightjar knows nothing about any client.

The public view holds: whether the run is alive (`never` with no `status.json`, `stopped` when its pid is dead, else the run's own state with its pause), and when it last wrote; one entry per busy Slot with its Feature, Ticket, kind of Session, when that Session started, its tail and its Feature's cost so far; spend today against `dailyUsd`; the completed builds with their outcome, cost and Tickets; and the repo's configuration, resolved with defaults through `loadConfig` at read time (Signal names, Tracker kind, `featureType`, the Tracker's organization and project), where a fault reads as a fault, never a throw. It leaves out the Queue, the Shelf and the Logbook, which a client reads from the Tracker or does not need. Every call takes a repo root and holds no shared state, so a client reads several repos by calling once per root.

`status.json` carries one integer `format`, which covers everything under `.factory/` the reader reads. It rises only on a breaking change, never when a field is added. A file without it is format 1. The reader reads every format it knows, and an unknown one reads as unsupported format N, never a throw or a misread, because the `nightjar` that writes `.factory/` and the package a client imports can differ.

## Considered Options

- **A local JSON API.** Rejected: it answers only while a server runs, and the run state is most wanted when nothing does.
- **`nightjar status --json`.** Rejected: a process per read, and no way to learn of a change without polling.
- **A published schema for `.factory/` alone.** Rejected: every client would rebuild the reader's work (the pid check, the ledger, the Session tails).
- **Export `FactoryView` as it is.** Rejected: it carries the page's own needs (the week, stages, the oldest build's fields kept for older files), and exporting it would freeze them as a contract.

## Consequences

- A spec reads frozen `.factory/` fixtures of each supported format through the public view, so a change that breaks a client fails `npm run check`.
- Stopping a run or a Slot from a client is left to a later decision. A read-only library rules none out: a `nightjar stop` command or a local endpoint can sit beside it.
