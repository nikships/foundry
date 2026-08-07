# .github/ — CI for agents

Workflows live in `workflows/`. Heavy Mac packaging and own-branch verification
run on the self-hosted Mac Mini. Fork PRs never execute on the Mini.

## Workflows

| File | Runner | Triggers | What it does |
|---|---|---|---|
| `workflows/ci.yml` | **self-hosted `mac-mini`** (own); `macos-latest` (fork PRs) | push/PR to `main` under `apps/desktop/**`, or manual | `npm ci` → typecheck → test → build |
| `workflows/mac-package.yml` | **self-hosted `mac-mini`** (this repo only) | push to `main`, `v*` tags, or manual | electron-builder arm64 DMG, Developer ID sign, Apple notarize + staple, artifact upload; **main/manual** → bump patch version, commit it back (a `GITHUB_TOKEN` push cannot retrigger workflows), then rolling GitHub Release tag `latest`; **`v*` tags** → versioned release (no bump) |

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

- CI typecheck/test/build for non-fork events
- Mac package / sign / notarize (`mac-package`)

**Not routed here:**

- Fork pull requests (`ci.yml` falls back to `macos-latest`)
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
