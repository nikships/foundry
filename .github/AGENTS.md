# AGENTS.md — .github

GitHub workflows own CI, security checks, and signed release automation.

## CI

- `ci.yml` runs on every pull request to `main` without path filtering. This is required so required checks are never left pending.
- `verify` uses Node 22 on `macos-26` and runs the repository static checks, coverage suite, build, and dependency audit.
- `android` runs `:app:testDebugUnitTest` with JDK 21 on Ubuntu.
- `actionlint` uses 1.7.12 or newer so `macos-26` is recognized.
- `e2e` builds and tests Electron with isolated fixtures. It is advisory and uploads Playwright artifacts on failure.
- Required checks are `verify`, `android`, and `actionlint`. E2E remains informational.
- Keep `codeql.yml` and `dependency-review.yml` separate from the main CI workflow.

`npm run check` is the canonical local pre-submit gate; do not duplicate its command chain in nested guides.

## Packaging

- `mac-package.yml` builds, signs, notarizes, and staples an arm64 DMG. Main/manual builds publish run-number versions to `Latest`; `v*` tags use the tagged package version.
- Mac packaging must fetch the pinned Bridge before electron-builder because the binary is gitignored but included and signed in the app bundle.
- `android-package.yml` tests, signs, verifies, and publishes `Foundry-Android.apk`.
- Mac and Android packaging share release concurrency and preserve the other platform’s assets when updating `Latest`.
- Keep signing identities and credentials in GitHub secrets. The Android signing key must remain stable for upgrades.
- `update-cliproxyapi.yml` periodically runs the Bridge bump flow and opens a pin-only PR. Its token must be able to trigger CI and packaging after merge.

## Droid

- `droid-review.yml` auto-reviews non-draft PRs via `Factory-AI/droid-action`.
- `droid.yml` splits `@droid` mentions:
  - `@droid fill` / `@droid review` / `@droid security` go to Factory's action.
  - Any other `@droid …` instruction (including `@droid fix`) runs `.github/scripts/droid-task.sh`, which implements the request on the PR branch and pushes. Factory's action has no general coding mode.
- Tag workflows only take effect after they land on the default branch.

## Editing workflows

- Keep non-obvious filters, runner versions, and signing choices commented in YAML.
- Pull requests use `.github/pull_request_template.md`.
- Validate workflow changes with the repository gate and `actionlint`.
- Use the `gh` CLI for run inspection and manual dispatch.
