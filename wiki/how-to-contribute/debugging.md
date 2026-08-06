# Debugging

How to see what a run (or the app) is doing when something fails.

## Doctor first

Settings and onboarding surface **Doctor** checks (`src/main/system/doctor.ts`): droid on PATH, version, auth expectations, git, OS floor. Fix red checks before chasing engine bugs.

## Live UI

- **Run detail** waterfall and phase drawer show tool calls, envelopes, gate evidence, corrections, and cost.
- Polling cadence is a setting (`pollCadenceMs`, default 500ms). Live view and history use the same `trace.events` cursor query.
- Kill a stuck run from the run header; process registry kills children first (`src/main/system/procs.ts`).

## SQLite traces

Per-project db:

```
~/Library/Application Support/foundry/projects/<hash-of-path>/trace.db
```

Useful inspection:

```sql
SELECT status, outcome_detail, worktree_path, branch FROM runs WHERE run_id = ?;
SELECT seq, name, kind, status, attempt, error FROM phases WHERE run_id = ? ORDER BY seq;
SELECT rowid, type, name, payload_json FROM events WHERE run_id = ? ORDER BY rowid;
SELECT gate, passed, checks_json FROM gate_results WHERE run_id = ?;
```

Raw files for a run (prompts, raw JSONL, envelopes) also land under the project's runs directory when the engine writes them; the db is the queryable mirror.

## Common failures

| Symptom | Likely cause | Where to look |
|---|---|---|
| Phase stuck `fail` after agent talk | Envelope parse or gate violation; corrections exhausted | envelopes / gate_results / correction events |
| `-32700` parse errors from droid | Missing `type` / Factory version fields, or numeric request id | `droid/protocol.ts`, client framing |
| Model / autonomy ignored | Nested settings object instead of flat params on `update_session_settings` | `droid/agent.ts` |
| Unauthorized write / phase fail | Write boundary or protected path | `engine/boundary.ts`, agent `writes` |
| UI button does nothing | Structured-clone failure on IPC payload | `renderer/api.ts` `plain()`, handler args |
| Run still `running` after crash | Orphan process row; relaunch sweep should finalize | `procs.ts`, `processes` table |
| Worktree left behind | Failed/killed run or crash | Settings maintenance / orphan worktrees |

## Headless engine

```bash
cd apps/desktop
npm run engine:demo
```

Useful when the UI is not the suspect. Pair with vitest for regressions.

## Logging

There is no separate log aggregation service. Prefer trace events (`log`, `error`, `correction`) and main-process console during `npm run dev`. Keep user-visible errors explicit in IPC responses so the UI can show them.
