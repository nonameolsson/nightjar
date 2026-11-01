# Releasing

How a person publishes `@nonameolsson/nightjar` to npm. Nothing here is run by an agent: no login, no publish. A person can publish by hand, or push a version tag and let `.github/workflows/release.yml` publish.

## Once: get the scope

The package name is scoped, `@nonameolsson/nightjar`, and publishing under a scope needs the scope to exist and be yours.

1. Sign up or sign in at <https://www.npmjs.com>, with two-factor authentication on (publishing needs it).
2. The scope `@nonameolsson` exists if it is your npm username. If it is not, create an organization named `nonameolsson` at <https://www.npmjs.com/org/create> (the free plan allows public packages).
3. In a terminal: `npm login`, then `npm whoami` must print the account that owns the scope.
4. `npm view @nonameolsson/nightjar` must answer 404: the name is free.

## Once: set up the release workflow

Only for publishing from CI. In the repo's Settings > Secrets and variables > Actions, add a secret `NPM_TOKEN`: a granular npm access token with read and write on `@nonameolsson/nightjar` that can publish without a one-time code (CI cannot type one). The workflow signs the package with npm provenance, which needs a public repo.

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

## Release from CI

Instead of steps 5 and 6, push the tag and let the workflow publish:

1. Steps 1 to 4 as above (`npm version` commits and tags `vX.Y.Z`).
2. `git push && git push --tags`.
3. The `release` workflow runs on the `v*` tag: `npm ci`, `npm run check`, fails unless the tag equals the `package.json` version, `npm publish --provenance` with `NPM_TOKEN`, then `gh release create` with generated notes.
4. Steps 7 and 8 as above once the run is green.

Do not also run `npm publish` by hand: the version would be published twice and the second attempt fails. A failed run that did not reach `npm publish` can be re-run from the Actions tab; one that did needs a new version.

## Other workflows

- `check`: on every pull request and push to `main`, runs `npm run check` (typecheck, lint, Prettier, specs, build, leak check, pack check) and, in a second job, `npm audit` on the production dependencies plus a signature check.
- `codeql`: CodeQL security scan on pull requests, `main` and weekly.
- Dependabot opens weekly update pull requests for npm and GitHub Actions.
