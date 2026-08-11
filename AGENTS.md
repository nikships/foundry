# Foundry repository

Native macOS Electron app (TypeScript + React 19) that turns a prompt into
reviewed code in an isolated run. Worktrees and branches are created by the
engine; code, not an agent, owns sequencing, retries, boundaries, and
acceptance.

## Architecture

- `apps/desktop/` is the application.
- A run normally uses `.foundry-worktrees/<runId>` and branch
  `foundry/<runId>`. The base checkout is not modified; merge/discard is an
  explicit operator action.
- A fresh worktree has tracked files only. Its project `setupScript` runs at
  the worktree root before phases. Phase handoffs are JSON files under
  `.foundry-handoff/`. For projects marked `scaffold`, a missing code command
  is a warning and that code phase is skipped rather than blocking creation.
- The main process owns git, disk, CLIs, and SQLite. The renderer reaches it
  only through shared IPC types, the preload bridge, and named channels.

## Invariants

- Every phase starts failed and succeeds only after a clean exit, parsed
  envelope, and passing gates. Boundaries are enforced after the call by
  diffing git; protected paths always fail.
- The `Tracer` is the sole SQLite writer. The trace directory guide covers the
  polling cursor and in-place event update rules.
- `finish()` settles run status and operator-facing completion state together;
  the main-process directory guide covers the lifecycle invariant.
- Electron takes a single-instance lock because a second SQLite writer would
  corrupt the per-project trace.

## Routing

The nearest directory guide is loaded automatically. Keep app work under the
desktop app directory, main-process behavior in its child directories, and CI
or release changes in the GitHub workflow directory.

From `apps/desktop/`, run `npm run check` before finishing. It includes
`check:css` and dependency auditing; CI enforces the same gates.
