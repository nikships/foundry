# AGENTS.md — .github

Workflows and release automation for Foundry. This guide is discoverable from the root `AGENTS.md`; workflow-specific behavior belongs here, not duplicated into every source guide.

## Project Overview

- Workflows live in `.github/workflows/`:
  - `ci.yml` — quality gates (`verify` on `macos-26` + `android` on `ubuntu-latest` + advisory `e2e` on `macos-26` + `actionlint` on `ubuntu-latest`)
  - `mac-package.yml` — signs, notarizes, and staples an arm64 DMG (`macos-26`)
  - `android-package.yml` — tests, signs, and publishes the Android companion APK (`ubuntu-latest`)
  - `update-cliproxyapi.yml` — scheduled pin bump for the vendored CLIProxyAPI Bridge
  - `codeql.yml`, `dependency-review.yml`, `junie-*.yml` — security/hygiene
- PR template in `.github/pull_request_template.md` (Summary + How verified + Agent notes).
- Issue forms in `.github/ISSUE_TEMPLATE/`: `bug_report.yml` (reproduction, expected/actual, environment, evidence, verification already run) and `feature_request.yml` (problem, proposal, alternatives, scope, acceptance criteria). `config.yml` keeps blank issues enabled — chores and umbrella tickets fit neither form. Both are pure GitHub forms: no secrets, no external services.

## Setup Commands

No local setup — workflows run on GitHub runners. To validate locally:

```bash
npm run check   # mirrors ci.yml's verify gate
```

`actionlint` requires 1.7.12+ (knows `macos-26`); older pins reject that label.

## Development Workflow

- `ci.yml` triggers: `push` on `main` (path-filtered for `apps/**` + `scripts/**` + `assets/**` + config + `.github/workflows/**`), plus every `pull_request` on `main` **without** a paths filter. The unfiltered PR trigger is intentional — `verify` + `android` + `actionlint` are required checks; a required check that never starts blocks PRs and even admin merges. The advisory `e2e` job rides the same triggers.
- `verify` runs from the repo root (Node 22, `npm ci`): typecheck, lint, format:check, `check:docs`, knip, `test:coverage`, build, `audit:deps` (high/critical only). It does **not** run `check:css` — that gate is local-only. It does **not** run `test:e2e`.
- `android` runs `./gradlew :app:testDebugUnitTest` from `apps/android/` (JDK 21, `ubuntu-latest`).
- `e2e` builds the app and runs `npm run test:e2e` (Playwright + Electron, isolated fixtures, no model). It is **advisory**: not a required check, not part of `npm run check`. Failures upload `playwright-report/` and `test-results/`. Promote only after the flake rate is known.
- `test:coverage` (not plain `test`) is deliberate: coverage thresholds live in `vitest.config.ts`, so CI and `npm run check` enforce the same floor and neither can drift from the other. Coverage is measured on `src/main`, `src/shared`, and `src/cli`; see the root `AGENTS.md` for scope and floors.
- `check:docs` is a fast static validator (`scripts/check-docs-commands.mjs`) that fails when a command documented in an `AGENTS.md`, the `README`, the `Makefile`, or a workflow no longer resolves to a real npm script or make target. It executes nothing it reads. It runs early in `verify` because it costs about a second and catches doc drift before the expensive jobs.
- `actionlint` runs on `ubuntu-latest` via `rhysd/actionlint/scripts/download-actionlint.bash 1.7.12`.
- Do not add a second local `check` recipe to source guides — `npm run check` is the canonical gate.

## Testing Instructions

```bash
# Validate CI locally before pushing
npm run typecheck && npm run lint && npm run format:check && npm run check:docs && npm run knip && npm run test:coverage && npm run build && npm run audit:deps

# Run Android unit tests locally
cd apps/android && ./gradlew :app:testDebugUnitTest

# Electron UI smoke (macOS GUI session; advisory, not part of the required gate)
npm run build && npm run test:e2e

# Lint workflows (requires actionlint)
bash <(curl -fsSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash) 1.7.12
./actionlint -shellcheck=

# Manual dispatch / rerun
gh run list --workflow ci.yml --limit 5
gh run list --workflow mac-package.yml --limit 5
gh run list --workflow android-package.yml --limit 5
gh run list --workflow update-cliproxyapi.yml --limit 5
```

- PRs must show green `verify` + `android` + `actionlint` before merge; CodeQL + dependency review are separate checks. The `e2e` job is informational until it is promoted.

## Packaging

`mac-package.yml` builds, signs, notarizes, and staples an **arm64 DMG** on `macos-26`. Triggers: desktop packaging source changes on `main`, `v*` tags, manual dispatch.

- **Main/manual:** run-number version, publishes a new `Latest` release without pushing to `main`.
- **Tags (`v*`):** uses the tagged `package.json` version.
- **Shared Latest release:** before promoting a new continuous Mac release, it carries the stable Android APK assets forward from the previous Latest release. Its concurrency group is shared with Android packaging so simultaneous source changes cannot race publication.
- **Bridge:** runs `npm run fetch:bridge` before electron-builder. The binary is gitignored and listed in `mac.binaries`; packaging without the fetch fails codesign on a missing `Contents/Resources/bridge/cli-proxy-api`.
- Signing secrets: `APPLE_CERT_P12` (`.p12`), certificate password, Apple ID + app‑specific password, `APPLE_TEAM_ID`. The workflow pins the **Developer ID Application** certificate SHA‑1 so an App Store identity in the same `.p12` is not selected.

`android-package.yml` runs for `apps/android/**` changes on `main` and manual dispatch. It tests and assembles a release APK, verifies its signature, then replaces `Foundry-Android.apk` and its checksum on the current Latest release. CI run numbers provide monotonically increasing Android version codes. It requires `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`; the signing key must remain stable for installed APKs to accept upgrades.

`update-cliproxyapi.yml` (every 12 hours / `workflow_dispatch`) compares `package.json` `config.bridge.version` to the latest [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) release, runs `scripts/fetch-bridge.mjs --bump`, and opens a pin-only PR. Merging that PR to `main` triggers `mac-package.yml`. Requires `AUTO_UPDATE_TOKEN` (PAT with `repo` + `workflow`); `GITHUB_TOKEN` cannot start CI on the PR or the release job after merge.

## Pull Request Guidelines

- Fill `.github/pull_request_template.md` — one paragraph Summary, `How verified` checklist (`npm run check` + CI green), and Agent/reviewer notes for contracts touched (IPC, envelopes, gates, boundaries) or intentional unused exports.
- Keep workflow edits small and commented; annotate non-obvious filters, runners, and version choices in the YAML.

## Additional Notes

- `codeql.yml` + `dependency-review.yml` are GitHub security checks — do not merge them into `ci.yml`.
