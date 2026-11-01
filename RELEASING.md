# Releasing

How a person publishes `@nonameolsson/nightjar` to npm. Nothing here is run by an agent: no login, no publish.

## Once: get the scope

The package name is scoped, `@nonameolsson/nightjar`, and publishing under a scope needs the scope to exist and be yours.

1. Sign up or sign in at <https://www.npmjs.com>, with two-factor authentication on (publishing needs it).
2. The scope `@nonameolsson` exists if it is your npm username. If it is not, create an organization named `nonameolsson` at <https://www.npmjs.com/org/create> (the free plan allows public packages).
3. In a terminal: `npm login`, then `npm whoami` must print the account that owns the scope.
4. `npm view @nonameolsson/nightjar` must answer 404: the name is free.

## Each release

From a clean `main` checkout:

1. `npm ci`
2. `npm run check`. It typechecks, lints, runs every spec, builds, checks no guarded name is in the repo or the packed files (`npm run leaks`), and packs, installs the tarball in a temp project and runs `nightjar --help` there (`npm run pack:check`).
3. `npm pack --dry-run` and read the file list: `dist/`, `schema/`, `skills/`, `plugin/nightjar-status/`, `docs/ticket-contract.md`, `src/status-shape.ts`, `README.md`, `LICENSE`, `package.json`.
4. `npm version minor` (the first release: `npm version 0.1.0`). It bumps `package.json`, commits and tags `vX.Y.Z`.
5. `npm publish`. `publishConfig.access` is already `public`, which a scoped package needs. Give the one-time code when npm asks.
6. `git push && git push --tags`.
7. In an empty folder: `npx @nonameolsson/nightjar --help` prints the usage.
8. Remove the "Not published to npm yet" note from the README's Install section.

If a published version is bad, `npm deprecate @nonameolsson/nightjar@X.Y.Z "reason"` and publish a fix; `npm unpublish` is only allowed for a short time after publishing.
