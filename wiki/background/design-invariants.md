# Design invariants

Rules that show up as comments and tests because breaking them silently corrupts runs or UX. Full coding style is in [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md).

## 1. Success is earned

A phase row is inserted as `fail` (see schema default in `src/main/trace/db.ts` and executor logic). It becomes `success` only after a clean path: process exit, valid envelope (agent), green gates (agent), boundary clean. Runs become `accepted` only through `finish()` against the pipeline's acceptance criterion.

## 2. Code owns the loop

Agents never decide run or phase success. The executor sequences phases, applies retry budgets, interprets gate reports, and calls `finish()`. This is the core control-plane split inherited from SSSF and restated in `PLAN.md` and `executor.ts` header comments.

## 3. Same session on correction

Envelope parse failures and gate failures re-prompt the **existing** droid session for that agent on that run. Envelope retries and gate retries are separate counters (settings / phase fields). Cold restart is the expensive path and is not the default repair.

## 4. Evidence-bearing gates

Gates return `GateCheck[]` (`item`, `ok`, `note`). The UI and trace store that evidence. An unknown gate name is a hard failure so typos cannot silently skip verification (`gates.ts`).

## 5. Boundary after the call

Write permission is not "the model promised." After an agent phase, the engine diffs git status against the phase-start snapshot, reverts unauthorized paths, and fails the phase with a violation list (`boundary.ts`). Protected paths always include things like `.git/` and app-owned dirs.

## 6. finish() is atomic for outcomes

Status, notification, banner art, and `outcome_detail` settle together so the dock badge, toast, and run header cannot disagree.

## 7. One writer, many pollers

Only the tracer writes run state. The renderer polls. There is no websocket push path and no alternate replay bus. Cursor:

```sql
SELECT * FROM events WHERE run_id = ? AND rowid > ? ORDER BY rowid LIMIT 500;
```

## 8. Derived costs, not denormalized phase columns

Per-phase tokens and cost are computed from events in `src/renderer/derive.ts`. Retries stay visible. Do not add denormalized total columns that hide intermediate attempts.

## 9. Named IPC only

The renderer's entire capability surface is `ipc-contract.ts`. No generic `invoke('eval')` escape hatch. Preload exposes named methods only.

## 10. Protocol fidelity over convenience

droid's stream-JSON-RPC rejects frames that look like "normal" JSON-RPC. Tests use `fake-droid.ts` to keep the quirks honest. Simplifying the client to match a friendly mock will break production.
