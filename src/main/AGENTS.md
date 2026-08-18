# AGENTS.md — src/main

Node main-process code. This is the only place that touches git, disk, child processes, CLIs, and SQLite. Renderer code never reaches these directly — it goes through the typed IPC seam (`src/shared/ipc-contract.ts` → `src/main/ipc/` → `src/preload/bridge.ts`).

## Project Overview

- Owns the Electron lifecycle (`main.ts`), project registry, run orchestration, and all privileged I/O.
- Subsystems (see siblings): `engine/` (sequencing/gates/worktrees), `pi/` (every agent call, run sessions and one-shots alike), `droid/` (model catalog, daemon policy, SDK), `cli/` (CLI install descriptors), `smith/` (entity-smith socket + approval queue), `trace/` (SQLite WAL), `store/` (JSON config), `system/` (PATH/procs/doctor), `ipc/` (routers), `updater.ts` (auto-update).
- State: `~/Library/Application Support/foundry/` (sharded per project). A run's file I/O belongs in `.foundry-worktrees/<runId>` on `foundry/<runId>`; merge/discard lives in `engine/worktree.ts`.

## Setup Commands

```bash
npm ci
node node_modules/electron/install.js  # only if Electron dist is absent (allow-scripts gate)
npm run dev                             # start Electron with this main code
npm run build                           # compile main + preload + renderer
```

No separate setup for `src/main/` — it builds as part of `electron-vite build`.

## Development Workflow

- Entry: `src/main/main.ts` — creates the `BrowserWindow` (`hiddenInset`, `sandbox: true`, `contextIsolation: true`), calls `resolveEnv()` before any spawn, sweeps orphaned runs from a previous crash, and registers IPC.
- Single-instance lock (`app.requestSingleInstanceLock()`) — a second SQLite writer would corrupt the per-project trace.
- Add a new capability via the IPC flow: `src/shared/types.ts` → `src/shared/ipc-contract.ts` → router in `src/main/ipc/` → `src/preload/bridge.ts` → `src/renderer/api.ts` through `plain()`. No generic `invoke(channel, ...)` passthrough.
- Long work returns a handle and pushes progress; do not `await` an agent turn inside a click handler.

## Testing Instructions

```bash
npm test                          # all suites (engine/droid/system/store/ipc)
npx vitest run -t "<pattern>"     # focus
npx vitest run tests/executor.test.ts  # engine executor with real git repos
npm run build && npm run test:e2e # Electron UI smoke (macOS GUI; not in npm run check)
```

- Engine/agent tests use **real git temp repos** and `tests/scripted-transport.ts` (an in-memory `AgentTransport`); never use network/model, never mock git.
- `tests/cli-vendors.test.ts` owns CLI fixtures; `tests/scripted-daemon.ts` owns the daemon handshake.
- Adding a phase kind or gate: update `src/shared/types.ts`, `engine/registry.ts`, and add a real-git executor test.

## Cross-Cutting Invariants

- **`finish()` is the only place that settles run status, notification, banner, and `outcome_detail`.** Do not update those independently — see `engine/runners/*.ts` and `system/notify.ts`.
- **Tracer is the sole SQLite writer.** No other module writes SQLite directly. See `trace/AGENTS.md` for WAL, `change_id` cursor, and in-place patch rules.
- **Worktree isolation.** Creation uses `.foundry-worktrees/<runId>` and `foundry/<runId>`; sweep on launch finalises orphaned `running` runs.
- **GUI PATH.** `system/env.ts:resolveEnv()` must complete before the first CLI spawn; every spawn uses `spawnEnv()`. See `system/AGENTS.md`.

## Code Style

- TypeScript `strict`; ESLint flat config (`eslint.config.js`) — `no-restricted-imports` forbids `@earendil-works/pi-*` outside `src/main/pi/` and `@factory/droid-sdk` outside `src/main/droid/sdk/`.
- No `eslint-disable` comments — fix the real issue.
- Imports: use `@main/*`, `@shared/*` aliases (kept in sync with `electron.vite.config.ts` + `tsconfig.json`).

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
npm run check  # full gate (also runs tests + audit)
```

Main is minified via `esbuild` in `electron.vite.config.ts` (`externalizeDepsPlugin()` keeps native deps external).

## Routing

| Subdirectory      | Responsibility                                            |
| ----------------- | --------------------------------------------------------- |
| `engine/`         | Sequencing, retries, boundaries, gates, setup, acceptance |
| `pi/`             | Every agent call: run sessions, one-shots, policy, tools  |
| `cli/`            | Install descriptors for CLIs the app does not run         |
| `droid/` + `sdk/` | Model catalog, daemon policy, SDK quirks, daemon session  |
| `smith/`          | Entity-smith socket, validation, proposal queue           |
| `ipc/`            | Domain routers, named channel seam                        |
| `store/`          | JSON config, migrations, builtin restoration              |
| `system/`         | PATH, process control, doctor, notifications, dock badge  |
| `trace/`          | SQLite WAL writer (`Tracer`)                              |

Adjacent `src/preload/`, `src/renderer/`, `src/shared/` guides cover the other sides of the process boundary.

## Additional Notes

- `AppContext` (`context.ts`) wires stores, tracer, registry, updater, and engine runners.
- Kill hierarchy: children before parents; verify `ps` argv before signalling a persisted pid (pids recycle).
