# CI and releases

Workflows live in `.github/workflows/`. This guide is discoverable from the
root guide; workflow-specific behavior belongs here rather than in every
source guide.

## Verification

From `apps/desktop/`, `npm run check` is the required local gate: typecheck,
lint, Prettier check, Knip, Vitest, Electron build, CSS collision check, and
dependency audit. The `ci.yml` verify job runs the same core checks but does
not run the CSS collision script; actionlint runs separately on Ubuntu. CodeQL
and dependency review are separate checks.

`ci.yml` verify runs on `macos-26`; its push verification is path-filtered and
pull requests/manual runs can invoke it directly. Do not add a second local
check recipe to source documentation.

## Packaging

`mac-package.yml` builds, signs, notarizes, and staples an arm64 DMG on
`macos-26`; it runs for `main`, `v*` tags, and manual dispatch. Main/manual
builds use a run-number version and publish a new Latest release without
pushing to `main`; tags use the tagged package version. Signing uses the
Developer ID `.p12`, certificate password, Apple ID/app-specific password,
and team ID repository secrets. The workflow pins the Developer ID
Application certificate SHA-1 so an App Store identity in the same `.p12` is
not selected.

Useful read-only commands:

```bash
gh run list --workflow ci.yml --limit 5
gh run list --workflow mac-package.yml --limit 5
```
