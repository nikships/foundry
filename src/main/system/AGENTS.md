# AGENTS.md — src/main/system

Owns launch environment resolution, process control, doctor checks, notifications, dock badges, and handing a directory to the user's terminal. Does not own pipeline logic. Doctor failures are advisory; the app still starts. Run completion (notification + badge) is settled by `finish()` in the engine.

## Project Overview

- `env.ts` — `resolveEnv()` captures the user's real PATH before any CLI spawn (launchd trap).
- `procs.ts` — tracked child registry + argv, `killAll()`, pid-recycle safety via `ps` argv check.
- `doctor.ts` — advisory startup checks.
- `notify.ts` / badge helpers — respect notification/badge settings while `finish()` owns completion state.
- `terminal.ts` — `open -a <App> <dir>` for the emulator in settings, plus the catalog and an install check. A handoff only: no PTY, no command injection, nothing tracked in `procs.ts` because `open` exits immediately.

## Setup Commands

```bash
npm ci
npm run dev    # resolveEnv() runs on startup; check console for [env] warnings
```

No system-specific install; relies on `$SHELL`, `ps`, and platform notifications.

## Development Workflow

- Every spawn (commands, catalog, one-shot, SDK sessions, process helpers, `which` lookups) must go through `spawnEnv()` with the `resolveEnv()` result — never `process.env` directly.
- New tracked spawns: register argv alongside the `processes` trace row so the recycle check can verify.
- Kill order: children before parents; keep registry and trace lifecycle in sync. Do not add an untracked spawn site.
- Doctor checks stay advisory — do not block app startup on failure.

## Testing Instructions

```bash
npm test
npx vitest run -t "env|procs|doctor"
npx vitest run tests/env.test.ts
```

- `env.test.ts` covers marker fencing and fallback detection; `procs` tests cover kill/recycle guards with a fake `ps`.

## Launch PATH

A GUI launch inherits launchd's minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `resolveEnv()` must complete before any CLI lookup or spawn and its result is cached. It runs `$SHELL -ilc` (not `-lc`) with marker fencing because profile files may print banners. Every spawn uses `spawnEnv()`, including CLI `which` lookups. An `ENOENT`‑shaped tail with `exitCode === null` means the binary was not found, not that the command ran and failed.

## Process Safety

Tracked children are registered with argv and the trace `processes` row. Before signalling a persisted pid, verify the current `ps` command still matches the recorded argv — pids can be recycled. Kill children before parents and keep the registry/trace lifecycle in sync. Do not add an untracked spawn site.

## Code Style

- Keep system modules side‑effect free except for their owned concern (env, procs, notifications).
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.
- Log via `console.warn` with a prefix (`[env]`) for startup diagnostics — not `console.log`.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
```

Bundled into `out/main/main.js`; no separate deploy.

## Additional Notes

- `ctx.updater.check()` is a no‑op in development builds; packaging triggers the real updater (see `.github/AGENTS.md`).
- Notifications respect user settings; `finish()` decides when to notify.
