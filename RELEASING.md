# Releasing

How a person publishes `@nonameolsson/nightjar` to npm. Nothing here is run by an agent: no login, no publish. A person creates a GitHub release and `.github/workflows/release.yml` bumps the version and publishes.

## Once: get the scope

The package name is scoped, `@nonameolsson/nightjar`, and publishing under a scope needs the scope to exist and be yours.

1. Sign up or sign in at <https://www.npmjs.com>, with two-factor authentication on (publishing needs it).
2. The scope `@nonameolsson` exists if it is your npm username. If it is not, create an organization named `nonameolsson` at <https://www.npmjs.com/org/create> (the free plan allows public packages).
3. In a terminal: `npm login`, then `npm whoami` must print the account that owns the scope.
4. `npm view @nonameolsson/nightjar` must answer 404: the name is free.

## Once: set up the release workflow

In the repo's Settings > Secrets and variables > Actions, add a secret `NPM_TOKEN`: a granular npm access token with read and write on `@nonameolsson/nightjar` that can publish without a one-time code (CI cannot type one). The workflow signs the package with npm provenance, which needs a public repo.

## Each release

From a green `main`:

1. On GitHub: Releases > Draft a new release. Create a new tag `vX.Y.Z` (targeting `main`), generate the notes, and publish. A tag with a suffix (`v1.2.3-rc.1`) is a prerelease and publishes under the `next` dist-tag.
2. The `release` workflow runs on the published release: sets `package.json` (and the lockfile) to the tag's version, runs `npm run check`, runs `npm publish --provenance` with `NPM_TOKEN`, then commits `Release X.Y.Z` to `main` with the bumped version.
3. In an empty folder: `npx @nonameolsson/nightjar --help` prints the usage.

Nobody runs `npm version` or `npm publish` by hand, and `package.json` on `main` only changes through that bump commit. If `main` is branch-protected, let `github-actions[bot]` bypass the rule, or the last step fails (the package is already published by then; bump the version in a pull request).

A failed run that did not reach `npm publish` can be re-run from the Actions tab. One that did needs a new version: delete the release and tag, and publish the next one. If a published version is bad, `npm deprecate @nonameolsson/nightjar@X.Y.Z "reason"` and release a fix; `npm unpublish` is only allowed for a short time after publishing.

Before the first release, check `npm pack --dry-run` lists `dist/`, `schema/`, `skills/`, `plugin/nightjar-status/`, `docs/ticket-contract.md`, `src/status-shape.ts`, `README.md`, `LICENSE`, `package.json`, and remove the "Not published to npm yet" note from the README's Install section.

## Other workflows

- `check`: on every pull request and push to `main`, runs `npm run check` (typecheck, lint, Prettier, specs, build, leak check, pack check) and, in a second job, `npm audit` on the production dependencies plus a signature check.
- `codeql`: CodeQL security scan on pull requests, `main` and weekly.
- Dependabot opens weekly update pull requests for npm and GitHub Actions.
