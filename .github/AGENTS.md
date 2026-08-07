# .github/ — CI for agents

Workflows live in `workflows/`. Everything runs on GitHub-hosted runners.
This is a **public** repo, so standard hosted Actions minutes are free.

## Agent-ready gates

PR merges should stay blocked until these are green. Local equivalent from
`apps/desktop/`:

```bash
npm run check   # typecheck + lint + format + knip + test + build + audit
```

| Gate | Tool | Where |
|---|---|---|
| Types | `tsc --noEmit` | `ci.yml` verify |
| Lint | ESLint (flat config) | `ci.yml` verify |
| Format | Prettier `--check` | `ci.yml` verify |
| Dead code / unused deps | Knip | `ci.yml` verify |
| Unit tests | Vitest | `ci.yml` verify |
| Production build | electron-vite | `ci.yml` verify |
| Dependency CVEs | `npm audit --audit-level=high` | `ci.yml` verify |
| Workflow syntax | actionlint | `ci.yml` actionlint |
| Supply-chain PR diff | dependency-review-action | `dependency-review.yml` |
| SAST | CodeQL (js/ts) | `codeql.yml` |
| Signed package | electron-builder + notary | `mac-package.yml` (not on PRs) |

Knip fails on unused files and dependencies. Unused exports are off for now
(internal modules export more than tests import on purpose); do not flip that
on without a cleanup pass.

## Workflows

| File | Runner | Triggers | What it does |
|---|---|---|---|
| `workflows/ci.yml` | `macos-26` (verify); `ubuntu-latest` (actionlint) | push/PR to `main` (verify also path-filtered on push), or manual | `npm ci` → typecheck → lint → format → knip → test → build → audit; plus actionlint |
| `workflows/dependency-review.yml` | `ubuntu-latest` | pull_request to `main` | Blocks high+ severity dependency changes and denied licenses |
| `workflows/codeql.yml` | `ubuntu-latest` | push/PR, weekly cron, manual | CodeQL security-and-quality on `apps/desktop` |
| `workflows/mac-package.yml` | `macos-26` | push to `main`, `v*` tags, or manual | electron-builder arm64 DMG, Developer ID sign, Apple notarize + staple, artifact upload; **main/manual** → local-only version `major.minor.<run_number>` (no push to `main`; keeps branch protection intact), then rolling GitHub Release tag `latest`; **`v*` tags** → versioned release (package.json as tagged) |

## Signing and notarization

`mac-package.yml` imports a temporary keychain on the hosted runner. Required
repo secrets:

| Secret | Purpose |
|---|---|
| `MAC_CERTS` | Base64-encoded Developer ID Application `.p12` |
| `CERT_PASSWORD` | Password for that `.p12` |
| `APPLE_ID` | Apple ID email for `notarytool` |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for `notarytool` |
| `APPLE_TEAM_ID` | Team id (`NW6B3R27LQ`) |

The package job pins `CSC_NAME` to the Developer ID Application certificate
SHA-1 so App Store identities that may ride along in the same `.p12` are not
picked by accident.

## Ops

```bash
# Manual package + publish rolling latest
gh workflow run mac-package.yml

# Watch CI
gh run list --workflow ci.yml --limit 5
gh run list --workflow mac-package.yml --limit 5
```
