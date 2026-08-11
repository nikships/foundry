# src/main/trace

`Tracer` is the sole SQLite writer for a project's WAL database. No other main
module writes SQLite directly. WAL lets renderer reads proceed while the
writer commits.

The renderer polls events with `run_id = ? AND change_id > ? ORDER BY rowid`.
`Tracer` initializes its in-memory cursor from `MAX(change_id)`, not row count;
`change_id` is the cursor and `rowid` is display ordering. Events are patched
in place (tool results land on their opening span and thinking grows through
deltas), so every insert and update must stamp a new `change_id`. The caller
advances to the maximum change id it saw and merges by `eventId`.

Do not add denormalized total-token columns. Cost, duration, and model are
derived from events so retries remain visible. If a new event is added, update
its renderer derivation/transcript handling as well as the trace writer.
