# Coding standards

What the reviewer holds a diff to. Each is a judgement call; anything `tsc`, `eslint` or a spec can enforce is enforced there, not here.

- **No toolchain assumed.** Nothing in Nightjar may assume a language, package manager or test runner of the repo it builds. A command that depends on one comes from `factory.json`.
- **Signals, not labels.** The build loop and every file outside the adapters speak of Signals (`src/signals.ts`). A label, tag or status name belongs to an adapter, which maps it.
- **Specs beside code.** A change to behaviour brings its `*.spec.ts` beside the file; a spec that needs a machine uses the stand-ins in `src/fakes/`.
- **Comments say why.** One line, only where the code cannot explain itself: a complex rule, or a reason not visible from the code.
- **The surrounding style.** New code matches the neighbouring file's naming, comment density and idiom.
