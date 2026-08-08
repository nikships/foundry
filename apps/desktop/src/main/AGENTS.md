# AGENTS.md — src/main

Main process (Node) owns git, disk, CLIs, SQLite. Renderer never touches
these directly — it goes through `src/shared/ipc-contract.ts` and `ipc/`.

## Invariants

- No generic IPC escape hatch. Every channel is named in `ipc-contract.ts`;
  add one there first, then a handler in `ipc/`, then expose in `preload/bridge.ts`.
- `finish()` is the only place that settles run status + notification + banner
  - `outcome_detail`. Don't set them separately.
- A run never touches the base checkout — all file I/O is inside the worktree.

Engine owns sequencing/retries/acceptance (`engine/AGENTS.md`). Adapters own
argv/parse per vendor (`cli/AGENTS.md`). Droid quirks live in `droid/AGENTS.md`.
Trace is single-writer via `Tracer` (`trace/AGENTS.md`). Config stores are
JSON with builtin seeds that must never clobber user edits (`store/AGENTS.md`).
