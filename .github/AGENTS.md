# AGENTS.md — .github

Workflows and release automation for Foundry. This guide is discoverable from the root `AGENTS.md`; workflow-specific behavior belongs here, not duplicated into every source guide.

## Project Overview

- Workflows live in `.github/workflows/`:
  - `ci.yml` — quality gates (`verify` on `macos-26` + `actionlint` on `ubuntu-latest`)
  - `mac-package.yml` — signs, notarizes, and staples an arm64 DMG (`macos-26`)
  - `codeql.yml`, `dependency-review.yml`, `junie-*.yml` — security/hygiene
- PR template in `.github/pull_request_template.md` (Summary + How verified + Agent notes).

## Setup Commands

No local setup — workflows run on GitHub runners. To validate locally:

```bash
cd apps/desktop
npm run check   # mirrors ci.yml's verify gate
```

`actionlint` requires 1.7.12+ (knows `macos-26`); older pins reject that label.

## Development Workflow

- `ci.yml` triggers: `push` on `main` (path-filtered for `apps/desktop/**` + `.github/workflows/**`), plus every `pull_request` on `main` **without** a paths filter. The unfiltered PR trigger is intentional — `verify` + `actionlint` are required checks; a required check that never starts blocks PRs and even admin merges. Both jobs are cheap enough to run on every PR.
- `verify` runs from `apps/desktop` (Node 22, `npm ci`): typecheck, lint, format:check, knip, test, build, `audit:deps` (high/critical only). It does **not** run `check:css` — that gate is local-only.
- `actionlint` runs on `ubuntu-latest` via `rhysd/actionlint/scripts/download-actionlint.bash 1.7.12`.
- Do not add a second local `check` recipe to source guides — `cd apps/desktop && npm run check` is the canonical gate.

## Testing Instructions

```bash
# Validate CI locally before pushing
cd apps/desktop
npm run typecheck && npm run lint && npm run format:check && npm run knip && npm test && npm run build && npm run audit:deps

# Lint workflows (requires actionlint)
bash <(curl -fsSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash) 1.7.12
./actionlint -shellcheck=

# Manual dispatch / rerun
gh run list --workflow ci.yml --limit 5
gh run list --workflow mac-package.yml --limit 5
```

- PRs must show green `verify` + `actionlint` before merge; CodeQL + dependency review are separate checks.

## Packaging

`mac-package.yml` builds, signs, notarizes, and staples an **arm64 DMG** on `macos-26`. Triggers: `main`, `v*` tags, manual dispatch.

- **Main/manual:** run-number version, publishes a new `Latest` release without pushing to `main`.
- **Tags (`v*`):** uses the tagged `package.json` version.
- Signing secrets: `APPLE_CERT_P12` (`.p12`), certificate password, Apple ID + app‑specific password, `APPLE_TEAM_ID`. The workflow pins the **Developer ID Application** certificate SHA‑1 so an App Store identity in the same `.p12` is not selected.

## Pull Request Guidelines

- Fill `.github/pull_request_template.md` — one paragraph Summary, `How verified` checklist (`npm run check` + CI green), and Agent/reviewer notes for contracts touched (IPC, envelopes, gates, boundaries) or intentional unused exports.
- Keep workflow edits small and commented; annotate non-obvious filters, runners, and version choices in the YAML.

## Additional Notes

- `codeql.yml` + `dependency-review.yml` are GitHub security checks — do not merge them into `ci.yml`.
