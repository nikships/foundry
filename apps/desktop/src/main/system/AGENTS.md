# AGENTS.md — src/main/system

Owns launch environment resolution, process control, doctor checks, notifications, and dock badges. Pipeline logic does not belong here.

## Launch environment

A GUI launch inherits launchd’s minimal `PATH`. `resolveEnv()` must complete before every CLI lookup or spawn, and all spawns use `spawnEnv()` rather than `process.env`. It runs `$SHELL -ilc` with marker fencing because profiles may print output.

An `ENOENT`-shaped result with `exitCode === null` means the binary was not found, not that it ran and failed.

## Process safety

- Track each child with its argv and trace process row.
- Before signalling a persisted PID, compare its current `ps` command with recorded argv because PIDs are recycled.
- Kill children before parents and keep registry and trace lifecycle aligned.
- `terminate(pid)` escalates SIGTERM to SIGKILL and reports whether the PID is gone. Close a process row only after that confirmation.
- Do not add untracked spawn sites.

Doctor failures remain advisory. `finish()` decides when run completion triggers notifications and badges.

## Validation

```bash
pnpm exec vitest run -t "env|procs|doctor"
pnpm exec vitest run apps/desktop/tests/main/system/env.test.ts
```

Startup diagnostics use prefixed `console.warn` messages.

## Forge CLIs (`gh` / `glab`)

`forge-ops.ts` is the shared typed surface for PR/MR list/view/create/merge and issue create, parameterized by provider. `forge.ts` picks GitHub vs GitLab from the preferred git remote. `gh.ts` keeps GitHub-only flows (account probe, `repo create`) and thin wrappers over forge-ops. Auth is satisfied by `auth status` **or** a token env var the CLI honors (`GH_TOKEN` / `GITHUB_TOKEN` for gh; `GITLAB_TOKEN` / `GITLAB_ACCESS_TOKEN` / `OAUTH_TOKEN` for glab). Doctor checks both installs and both auth paths via `appendForgeDoctorChecks`; neither is blocking.
