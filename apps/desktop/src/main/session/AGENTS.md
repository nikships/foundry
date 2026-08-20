# AGENTS.md — src/main/session

Shared live-panel session for work that is not a run: command detection,
setup-script generation, and the readiness remediator. One module owns the
entries ring, cancel/abort, transcript fold, snapshot clone, and the
finished-session cache. Feature-specific ask-and-parse stays in the caller.

## Project Overview

- `panel-session.ts` — `PanelSession<TState>`: entries cap, status/detail/
  timestamps, cancel/abort of an injected `OneShotFactory`, `foldTranscript`,
  and a cloned snapshot.
- `registry.ts` — `SessionRegistry<T>` (sweep, keep-limits, `cancelAll`) and
  `createPanelRegistry()` which is the public surface: `start(deps) → id`,
  `get(id)`, `cancel(id)`.
- No git. No sqlite. The only runtime dependency is an injected
  `OneShotFactory`.

Detection and setup are thin strategies behind `createPanelRegistry`. The
readiness onboarding state machine in `readiness/session.ts` composes
`PanelSession` for the shared ring/cancel/snapshot and uses `SessionRegistry`
for the cache; its git/worktree/PR steps stay there.

## Setup Commands

```bash
npm ci
npm run test
```

No standalone setup — this bundles as part of `electron-vite build`.

## Development Workflow

A new one-shot panel:

1. Extend `PanelStateCore` in `src/shared/types.ts` (or `ipc-contract.ts` for
   an IPC-only state).
2. Write a thin strategy that builds a `PanelSession`, asks, and parses.
3. Expose it with `createPanelRegistry({ create, idOf, snapshot, isLive, run })`.
4. Add prompt/parse tests next to the strategy; keep cap/cancel/sweep tests in
   `apps/desktop/tests/main/session/panel-session.test.ts`.

## Testing Instructions

```bash
npm test
npx vitest run apps/desktop/tests/main/session/panel-session.test.ts
npx vitest run apps/desktop/tests/main/engine/detect-session.test.ts
```

- The session/registry suite owns cap, snapshot-clone, cancel/abort, transcript
  fold, sweep, and keep-limits. Do not retest those in detect or readiness.
- Per-feature tests keep only prompt/parse (and detect's verify-by-running).
- Drive turns with `apps/desktop/tests/helpers/scripted-oneshot.ts`. Never use a network or model.

## Invariants

- **A session is an object, not a promise.** The click returns an id; progress
  is pushed; cancel aborts the child. `run()` never rejects.
- **Snapshots are clones.** The renderer receives structured-clone payloads and
  must never share an array the session is still mutating.
- **Finished sessions are a cache.** `KEEP_MS` / `MAX_KEPT` drop old results.
  A live session is never evicted. Replacing an id clears its `endedAt`.
- **Read-only means no write tool exists.** Detection and setup open
  `access: 'read'` against the operator's checkout.

## Code Style

- No `eslint-disable`. Use `@main/*` / `@shared/*` aliases.
- Keep this directory ignorant of git, sqlite, and `AppContext`.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
npm run check
```

No session-specific build step.
