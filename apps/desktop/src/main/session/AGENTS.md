# AGENTS.md — src/main/session

Shared live-panel infrastructure for non-run work such as command detection, setup generation, and readiness remediation.

## Ownership

- `panel-session.ts` owns the bounded entry ring, cancellation, transcript fold, cloned snapshots, status, and timestamps.
- `registry.ts` owns live-session lookup and bounded retention of finished sessions.
- Feature-specific prompting, parsing, Git, worktrees, and PR behavior stay in the caller.
- The only runtime dependency is an injected `OneShotFactory`; this directory must not depend on Git, SQLite, or `AppContext`.

## Invariants

- **A session is an object, not a promise.** Start returns an ID, progress is pushed, cancellation aborts the child, and `run()` never rejects.
- **Snapshots are clones.** Never expose arrays that a live session still mutates.
- **Finished sessions are a bounded cache.** Never evict a live session.
- **Read-only means no write tool exists.** Detection and setup use `access: 'read'`.

Feature tests should cover only their prompt/parse behavior. Ring, cancellation, snapshot, sweep, and retention behavior belongs in the shared session tests.

## Validation

```bash
npx vitest run apps/desktop/tests/main/session/panel-session.test.ts
npx vitest run apps/desktop/tests/main/engine/detect-session.test.ts
```

Drive turns with `apps/desktop/tests/helpers/scripted-oneshot.ts`, never a real model.
