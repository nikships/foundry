# .github/ — CI for agents

Workflows live in `workflows/`. Heavy Mac packaging and own-branch verification
run on the self-hosted Mac Mini. Fork PRs never execute on the Mini.

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
| `workflows/ci.yml` | **self-hosted `mac-mini`** (own); `macos-latest` (fork PRs); actionlint on `ubuntu-latest` | push/PR to `main` under `apps/desktop/**` or `.github/workflows/**`, or manual | `npm ci` → typecheck → lint → format → knip → test → build → audit; plus actionlint |
| `workflows/dependency-review.yml` | `ubuntu-latest` | pull_request to `main` | Blocks high+ severity dependency changes and denied licenses |
| `workflows/codeql.yml` | `ubuntu-latest` | push/PR under app paths, weekly cron, manual | CodeQL security-and-quality on `apps/desktop` |
| `workflows/mac-package.yml` | **self-hosted `mac-mini`** (this repo only) | push to `main`, `v*` tags, or manual | electron-builder arm64 DMG, Developer ID sign, Apple notarize + staple, artifact upload; **main/manual** → local-only version `major.minor.<run_number>` (no push to `main`; keeps branch protection intact), then rolling GitHub Release tag `latest`; **`v*` tags** → versioned release (package.json as tagged) |

## Self-hosted runner (`mac-mini`)

Repo-specific runner on the Mac Mini (`nikhilanand@192.168.1.11`). **Do not
retarget or stop runners that belong to other repositories.**

| | |
|---|---|
| Runner name | `mac-mini-nikships-software-factory` |
| Labels | `self-hosted`, `macOS`, `ARM64`, `mac-mini`, `nikships-software-factory` |
| Install path | `~/actions-runner-nikships-software-factory` |
| LaunchAgent | `actions.runner.nikships-software-factory.mac-mini-nikships-software-factory` (user agent, Aqua session — **not** a LaunchDaemon) |
| Toolchain env | `DEVELOPER_DIR` → `/Volumes/NVMe/Xcode.app/Contents/Developer`; Homebrew Node; `PATH` via LaunchAgent + runner `.env` |
| Xcode | External always-mounted NVMe: `/Volumes/NVMe/Xcode.app` |

**Routed here:**

- CI verify (typecheck/lint/format/knip/test/build/audit) for non-fork events
- Mac package / sign / notarize (`mac-package`)

**Not routed here:**

- Fork pull requests (`ci.yml` falls back to `macos-latest`)
- actionlint, dependency-review, CodeQL (`ubuntu-latest`)
- Light docs-only work (no workflow)

### Signing and notarization

- **Codesign:** Mini login keychain already has
  `Developer ID Application: Nikhil Anand (NW6B3R27LQ)` (team `NW6B3R27LQ`).
  Prefer that identity. Do **not** import a P12 that duplicates it or codesign
  fails with “ambiguous”. Requires the Aqua-session LaunchAgent or the keychain
  is invisible (signing step will show `1 valid identities found` instead of `3`).
- **Notarize:** prefer GitHub secrets
  `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD`. If those are
  incomplete, the package job falls back to the Mini keychain profile
  `notarytool` (already present on the host for other Mac release jobs).
- Optional secrets (not required while login keychain works):
  `APPLE_DEVELOPER_CERTIFICATE_P12_BASE64`,
  `APPLE_DEVELOPER_CERTIFICATE_PASSWORD`,
  `APPLE_DEVELOPER_ID_APPLICATION`.

### Public-repo safety

This repository is **public**. Self-hosted jobs must not run untrusted fork code
(RCE on the Mini). `mac-package.yml` has **no** `pull_request` trigger.
`ci.yml` routes fork PRs to `macos-latest`.

### Ops

```bash
LABEL=actions.runner.nikships-software-factory.mac-mini-nikships-software-factory
RUNNER_DIR=~/actions-runner-nikships-software-factory

# Status (GUI domain — no sudo)
ssh nikhilanand@192.168.1.11 "launchctl print gui/\$(id -u)/$LABEL | grep 'state ='"
gh api repos/nikships/software-factory/actions/runners --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'

# Restart after .env change
ssh nikhilanand@192.168.1.11 "launchctl kickstart -k gui/\$(id -u)/$LABEL"

# Manual package + install to Applications on the Mini
gh workflow run mac-package.yml -f install_to_applications=true
```

- **Service model:** user LaunchAgent with `SessionCreate=true` and
  `LimitLoadToSessionType=Aqua`. Never convert to a system LaunchDaemon (breaks
  login-keychain codesign and any future Xcode tests).
- **Reboot survival:** auto-login (`autoLoginUser = nikhilanand`), not a daemon.
- **NVMe** must stay mounted at `/Volumes/NVMe`.
- One job at a time on this agent; other Mini repos have their own runners.
- Logs: `~/Library/Logs/actions.runner.nikships-software-factory.mac-mini-nikships-software-factory/`
