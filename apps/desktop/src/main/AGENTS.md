# src/main

Node main-process code owns git, disk, child processes, CLIs, and SQLite.
Renderer code never reaches these directly: use the named IPC seam described
in `ipc/` and the shared contract.

## Cross-cutting invariants

- `finish()` is the only place that settles run status, notification, banner,
  and `outcome_detail`; do not update those independently.
- A run's file I/O belongs in its isolated worktree. Worktree creation uses
  `.foundry-worktrees/<runId>` and `foundry/<runId>`; merge/discard remains in
  `engine/worktree.ts`.
- `Tracer` is the sole SQLite writer and owns event/process persistence. Its
  cursor details are in the trace directory guide.
- Resolve the GUI environment before the first CLI spawn; the system directory
  guide documents the launchd PATH trap.

## Routing

- `engine/`: sequencing, retries, boundaries, gates, setup, and acceptance.
- `cli/`: vendor argv and one-shot output parsing.
- `droid/`: daemon/RPC/one-shot transport, SDK quirks, and permission policy.
- `ipc/`: domain routers and the named channel seam.
- `store/`: JSON configuration, migrations, and builtin restoration.
- `system/`: PATH, process control, doctor checks, and notifications.
- `trace/`: the only SQLite write path.

The adjacent `src/preload/`, `src/renderer/`, and `src/shared/` guides cover
the other sides of the process boundary.
