# AGENTS.md — src/main/trace

`Tracer` is the sole SQLite writer. Each project has a WAL database; one app-scoped database stores processes, currently the Bridge, that belong to no run or project.

## Invariants

- **Single writer, WAL mode.** No other module writes SQLite.
- **Cursor semantics.** `change_id` is the polling cursor; `rowid` is display order. Seed the high-water mark from `MAX(change_id)`.
- **Every insert and update advances `change_id`.** Otherwise polling misses in-place tool-result or thinking patches.
- **Merge events by `eventId`.** The caller advances to the maximum observed cursor.
- **No denormalized totals.** Usage, duration, and model are derived from events so retries remain inspectable.
- App-scoped process rows use a null `run_id` and live in `appDbPath()`.

Use prepared statements and keep synchronous `better-sqlite3` access focused in `tracer.ts`.

Adding an event usually requires its shared shape, Tracer write path, renderer derivation, and an Inspector `TranscriptEntry` branch. Unknown events are otherwise silently omitted.

## Validation

```bash
npx vitest run apps/desktop/tests/main/trace/trace-cursor.test.ts
```

Use real temporary SQLite files and assert both row content and cursor advancement.
