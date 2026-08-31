# AGENTS.md — src/main

Node main-process code. This is the only place that touches git, disk, child processes, CLIs, and SQLite. Renderer code never reaches these directly — it goes through the typed IPC seam (`src/shared/ipc-contract.ts` → `src/main/ipc/` → `src/preload/bridge.ts`).

## Project Overview

- Owns the Electron lifecycle (`main.ts`), project registry, run orchestration, and all privileged I/O.
- Subsystems (see siblings): `engine/` (sequencing/gates/worktrees), `pi/` (every agent call, run sessions and one-shots alike), `session/` (shared panel session + registry for detect/setup/readiness), `readiness/` (agent-readiness evaluation), `smith/` (native entity-smith chat + approval queue), `trace/` (SQLite WAL), `store/` (JSON config), `system/` (PATH/procs/doctor), `ipc/` (routers), `updater.ts` (auto-update).
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
npm test                          # all suites (engine/pi/system/store/ipc)
npx vitest run -t "<pattern>"     # focus
npx vitest run apps/desktop/tests/main/engine/executor.test.ts  # engine executor with real git repos
npm run build && npm run test:e2e # Electron UI smoke (macOS GUI; not in npm run check)
```

- Engine/agent tests use **real git temp repos** and `apps/desktop/tests/helpers/scripted-transport.ts` (an in-memory `AgentTransport`); never use network/model, never mock git.
- `apps/desktop/tests/helpers/scripted-transport.ts` owns the agent-transport fixture; `apps/desktop/tests/main/system/doctor.test.ts` owns the provider-doctor fixtures.
- Adding a phase kind or gate: update `src/shared/types.ts`, `engine/registry.ts`, and add a real-git executor test.

## Cross-Cutting Invariants

- **`finish()` is the only place that settles run status, notification, banner, and `outcome_detail`.** Do not update those independently — see `engine/runners/*.ts` and `system/notify.ts`.
- **Tracer is the sole SQLite writer.** No other module writes SQLite directly. See `trace/AGENTS.md` for WAL, `change_id` cursor, and in-place patch rules.
- **Worktree isolation.** Creation uses `.foundry-worktrees/<runId>` and `foundry/<runId>`; sweep on launch finalises orphaned `running` runs.
- **GUI PATH.** `system/env.ts:resolveEnv()` must complete before the first CLI spawn; every spawn uses `spawnEnv()`. See `system/AGENTS.md`.
- **A generated plan appoints every agent phase's model and reasoning effort explicitly.** Automatic casting uses the union of explicit Settings → Agent Defaults and per-run Orchestrator model pins; if both inherit, it uses the full enabled catalog (`pi/enabled-models.ts` — reachable minus `hiddenModelIds`). A configured pin that is unavailable or hidden fails planning instead of broadening the pool. `orchestrator/plan.ts:phaseModelIssues` rejects a phase that omits either appointment, writes `inherit`, names a model outside that planning pool, or chooses reasoning that model does not support. `startRun` checks the live enabled catalog again, deliberately allowing the operator to re-cast a phase or change its reasoning on the plan card before confirming, and fails closed if that catalog is unavailable. A mid-run amendment may only re-cast onto a model the confirmed plan already names. An empty catalog stands down the planning rail only when neither configuration pin constrains casting.

## Code Style

- TypeScript `strict`; ESLint flat config (`eslint.config.js`) — `no-restricted-imports` forbids `@earendil-works/pi-*` outside `src/main/pi/`.
- No `eslint-disable` comments — fix the real issue.
- Imports: use `@main/*`, `@shared/*` aliases (kept in sync with `electron.vite.config.ts` + `tsconfig.json`).

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
npm run check  # full gate (also runs tests + audit)
```

Main is minified via `esbuild` in `electron.vite.config.ts` (`externalizeDepsPlugin()` keeps native deps external).

## Routing

| Subdirectory | Responsibility                                                |
| ------------ | ------------------------------------------------------------- |
| `engine/`    | Sequencing, retries, boundaries, gates, setup, acceptance     |
| `pi/`        | Every agent call: run sessions, one-shots, policy, tools      |
| `session/`   | Shared `PanelSession` + `SessionRegistry` for one-shot panels |
| `readiness/` | Agent-readiness evaluation, marker, remediation session       |
| `bridge/`    | Vendored CLIProxyAPI: provider OAuth → local endpoint         |
| `smith/`     | Native in-app chat, entity/readiness tools, proposal queue    |
| `ipc/`       | Domain routers, named channel seam                            |
| `store/`     | JSON config, builtin restoration                              |
| `system/`    | PATH, process control, doctor, notifications, dock badge      |
| `trace/`     | SQLite WAL writer (`Tracer`)                                  |

Adjacent `src/preload/`, `src/renderer/`, `src/shared/` guides cover the other sides of the process boundary.

## Additional Notes

- `AppContext` (`context.ts`) wires stores, tracer, registry, updater, and engine runners.
- Kill hierarchy: children before parents; verify `ps` argv before signalling a persisted pid (pids recycle).
