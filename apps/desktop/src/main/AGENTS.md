# AGENTS.md — src/main

The Electron main process owns Git, disk, child processes, CLIs, SQLite, application lifecycle, and all other privileged work.

## Local boundaries

- `main.ts` resolves the GUI environment before spawning, preserves the single-instance lock, sweeps orphaned runs, and registers IPC.
- The first window opens before slow Bridge and Companion restoration. Keep those off the first-paint path.
- Long work returns a handle and pushes progress; never await an agent turn inside a click handler.
- A run’s file I/O belongs in its engine-owned worktree.
- `finish()` alone settles run status, outcome, notification, and banner.
- `Tracer` alone writes SQLite.
- New capabilities follow shared contract → domain router → preload wrapper → renderer API. No generic IPC dispatch.

## Subsystems

| Path         | Responsibility                                                |
| ------------ | ------------------------------------------------------------- |
| `engine/`    | Sequencing, worktrees, boundaries, gates, healing, settlement |
| `pi/`        | Agent sessions, one-shots, tools, policy, runtime             |
| `session/`   | Shared live panel session and registry                        |
| `readiness/` | Agent-readiness evaluation and remediation                    |
| `bridge/`    | Vendored provider-subscription Bridge                         |
| `smith/`     | Native operator chat, tools, and proposals                    |
| `ipc/`       | Typed domain routers                                          |
| `store/`     | JSON configuration and builtin seeding                        |
| `system/`    | Environment, processes, doctor, notifications                 |
| `trace/`     | SQLite WAL writer                                             |

Read the subsystem guide before changing one of these contracts.

## Model casting

Generated plans explicitly appoint every agent phase’s model. The cast pool is the enabled catalog minus hidden models; Agent Defaults and Orchestrator pins are preferred for expensive phases when they sit in that pool, not a shrink-wrap around two ids. Unnamed or `inherit` phase models are rejected. When the pool spans two or more provider prefixes, a review that uses the same prefix as the last build is a warning, not a hard error. A confirmed plan may be recast by the operator before start; mid-run amendments may only use models already named by that plan.

The cast pool describes effort levels and vendored Artificial Analysis intelligence, not price or context size. Unknown scores render as unrated, never zero.

## Validation

Use the closest subsystem tests. Engine behavior requires real-Git tests with the scripted transport; UI flow requires the built Electron smoke only when relevant.
