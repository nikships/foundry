# AGENTS.md — src/main/trace

Single-writer SQLite (WAL) — the only data path from main to renderer.

Renderer polls `events where run_id = ? and change_id > ? order by rowid limit 500`.
Cursor is `change_id`, not `rowid` — rows are patched in place (tool result
lands on the span that opened it, thinking grows via deltas) and every insert

- update stamps a fresh `change_id` so patched rows are re-served. Ordering is
  `rowid`; renderer merges by `eventId`. No websocket.

Don't add a denormalised `total_tokens` column — per-phase cost/duration/model
are derived from events in `src/renderer/derive.ts` so a retry's real cost
stays visible. Never write to SQLite outside `Tracer`; WAL is on so reads
never block.
