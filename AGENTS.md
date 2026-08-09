# AGENTS.md

For coding agents working on this repo's source (you). Not for agents
running inside Foundry.

## What Foundry is

Native macOS Electron app (TypeScript + React 19) that turns a prompt into
reviewed code in an isolated git worktree you can watch live.

You describe the work, pick a pipeline, start a run. A roster of specialist
agents does each phase, code judges every phase, your base checkout stays
untouched until you merge `foundry/run_*` yourself.

Philosophy: **agent proposes, code disposes**. Agents work inside one bounded
phase; code owns sequencing, retries, corrections, and acceptance.

## How it works

Pipelines are data, not scripts — an ordered list of `agent | code | engineer`
phases. The deterministic engine walks them, creates a worktree + branch per
run, snapshots git at phase start, enforces write boundaries after each phase
by diffing `git status` (violations are reverted), checks envelopes + gates,
and retries the same live session on failure. Every run is traced to SQLite
(WAL); the renderer polls `where change_id > ?` — no websocket. `change_id`
is the cursor (rows are patched in place), `rowid` is ordering.

Agent phases are driven via the `droid` CLI adapter.

## What lives where

- `apps/desktop/` — the app. All work happens here.
- `.claude/skills/sssf/` — original Python factory. Reference only: read for
  concepts, never import/execute/link, never add Python to `apps/desktop/`.

## Invariants (don't break from any layer)

- A phase is born `fail`, flips to `success` only on clean exit + parsed
  envelope + green gates.
- Code owns sequencing/retries/acceptance. No agent decides if it succeeded.
- Write boundaries are enforced after the call by diffing git, not by prompting
  nicely. Protected paths (`.git`, `.foundry`, lockfiles) always fail.
- `finish()` settles status, notification, banner, and `outcome_detail` together.

## Working in the app

Details live in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md). From
`apps/desktop/`, `npm run check` (typecheck + lint + format + knip + test +
build + audit) must pass before you finish. CI enforces the same.

Deeper docs are next to the code you are touching — e.g.
`src/main/engine/AGENTS.md`, `src/main/cli/AGENTS.md`. Read the closest one;
they contain only what `ls` and the code won't tell you.
