# AGENTS.md — src/main/trace

`Tracer` is the sole SQLite writer for a project's WAL database. No other main module writes SQLite directly. WAL lets renderer reads proceed while the writer commits.

## Project Overview

- Each project has its own `trace.db` (under `~/Library/Application Support/foundry/`). Schema lives in `db.ts`; event/process persistence lives in `tracer.ts`.
- Events are pulled by the renderer via `run_id = ? AND change_id > ? ORDER BY rowid` — a polling cursor merge (see `src/renderer/stores/run.tsx`).
- Tool results patch their opening span and thinking deltas append in place — both require a new `change_id`.
- Usage, duration, and model are **derived** from events (in `src/renderer/derive.ts`), not denormalized, so retries remain visible.

## Setup Commands

```bash
npm ci
npm run dev    # Tracer opens WAL databases for each project on demand
```

No separate trace setup. `better-sqlite3` is a native dep (allow‑listed in `.npmrc`); if missing after install, run `node node_modules/electron/install.js`.

## Development Workflow

- All writes go through `Tracer`. Open questions: check `tracer.ts` for the allowed tables/methods.
- Adding a new event: update `src/shared/types.ts` (shape), `tracer.ts` (writer), `src/renderer/derive.ts` (usage/duration/model derivation), and `src/renderer/inspector/entries.tsx` (`TranscriptEntry` switch — default silently drops unknown events).
- Do not add a denormalized cost column. Usage is derived from events.

## Testing Instructions

```bash
npm test
npx vitest run -t "trace|tracer"
npx vitest run tests/trace-cursor.test.ts
```

- Trace tests use real SQLite databases (temp files). Assert on rows and `change_id` advancement, not mocks.
- When patching spans (tool result, thinking delta), assert that `change_id` increments.

## Invariants

- **Single writer, WAL mode.** Second writer (e.g. second Electron instance) would corrupt — hence the single-instance lock in `src/main/main.ts`.
- **Cursor semantics:**
  - `change_id` = polling cursor. `Tracer` seeds its in-memory high-water mark from `MAX(change_id)`, not row count.
  - `rowid` = display ordering (insertion order).
  - Caller advances to `max(change_id)` observed and merges by `eventId`.
- **In‑place patching:** every insert AND update must stamp a new `change_id`, otherwise the renderer's poll misses the patch.
- **No denormalized totals.** Usage/duration/model are event-derived so retries remain inspectable.

## Code Style

- `tracer.ts` is the narrow write surface — keep it focused and transaction-safe.
- Use prepared statements; keep DB access synchronous (WAL + `better-sqlite3` is sync).
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
```

Trace code bundles into `out/main/main.js`; `better-sqlite3` stays externalized (native).

## Additional Notes

- Renderer cursor merge lives in `src/renderer/stores/run.tsx`; Inspector rendering in `inspector/entries.tsx`.
- `finish()` in the engine runner is the only caller that settles run-level status against traced events.
