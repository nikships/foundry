# Runs and traces

Runs are the unit of work the operator starts, watches, kills, and reviews. The trace is the durable event stream for each run: SQLite written only by the main process, polled by the renderer. Live view and history are the same query with different poll cadence.

## Why it exists

Operators need a home screen that starts work and a detail view that behaves like a build monitor. Skeptics need gate evidence, costs, prompts, and raw tool payloads one click deep. Nothing about factory progress is pushed over websockets; the UI always pulls.

## Runs screen (home)

`apps/desktop/src/renderer/screens/RunsScreen.tsx`.

- **Composer** (when a project is selected): request textarea, pipeline select, phase ribbon for the selected pipeline, **Start run** (⌘↵).
- Start calls `runs.start` with project, pipeline id, and request. Validation issues from the engine/store surface inline.
- **Run list**: status badge, pipeline name, age, truncated request, phase progress summary, optional cost/tokens. Toggle to include archived runs.
- Empty states for no project and no runs yet (`EmptyState` + scene art).

Without a project, the composer is hidden and the user is pointed at adding a repository.

## Run detail

`apps/desktop/src/renderer/screens/RunDetailScreen.tsx`.

### Header

- Back to Runs, status badge, pipeline name, start time, full request text.
- Live facts: elapsed duration, tokens, credits, branch link (open worktree).
- **Kill run** while `live`.
- **Cost** toggle for the cost table.

### Outcome banner

When the run is no longer `running`, `OutcomeBanner` shows:

| Status | Headline emphasis |
|---|---|
| `accepted` | Accepted (green art/copy). |
| `rejected` | Not accepted (acceptance criterion failed). |
| `killed` | Killed by hand. |
| `failed` | Engine could not finish. |

Copy prefers `run.outcomeDetail` when set (settled together with status and notification in `finish()`). For unfinished worktrees, merge and discard actions appear so isolation policy can complete from the UI. See [Worktrees](worktrees.md).

### Waterfall

`Waterfall`: swim lanes for engineer / code / one lane per agent (colour + emblem), phase blocks on a time axis, queued phases dashed. Selecting a phase opens the drawer. Running phase auto-selected when live; otherwise last fail or first phase.

### Phase drawer

`PhaseDrawer` tabs:

| Tab | Content |
|---|---|
| Timeline | Event list (tool calls, corrections, gates, …); expand for JSON payload. Live text tail while the agent is mid-turn. |
| Envelope | Each attempt's payload, parsed / did not parse. |
| Gates | Per gate: pass/fail plus one row per `GateCheck` (`item` + `note`). Evidence, not a bare checkmark. |
| Prompt | Recorded prompt for agent phases. |

Attempt badges appear when a phase retried. Phase error banner when the phase failed with a message.

### Cost table

`CostTable`: one row per agent phase that started, with model, turns, input / output / cache read / thinking tokens, and credits. Totals at the bottom. If the model omitted usage, the row says so honestly instead of showing zeros.

Per-phase cost and duration are **derived** from events in `src/renderer/derive.ts`, not denormalised as phase columns. That keeps retry cost visible in the event stream.

## Polling

`useRun` in `apps/desktop/src/renderer/stores/run.tsx`:

1. Fetch run detail (phases, envelopes, gates, sessions, live flag).
2. Fetch events after the last `rowid` cursor (`trace.events` / `runs.events`).
3. Append events; advance cursor.
4. Reschedule: live cadence from `settings.pollCadenceMs` (default 500 ms); finished runs slow to about 3 s.

The SQL contract (main side) is:

```sql
select * from events where run_id = ? and rowid > ? order by rowid limit 500;
```

WAL is on so UI reads never block the engine writer. No websocket, no push channel, no separate replay path.

Run list polling is similar at project scope (`useRunList`).

## Kill

Kill goes through `runs.kill` → process registry: recorded PIDs, children first, then finalize the run to `killed`. Worktrees are left in place so partial work remains reviewable. On app relaunch, processes with `ended_at` null whose PIDs are gone finalize stuck runs to `failed` so the UI never freezes on `running` forever.

## Trace storage (operator view)

- Path: `~/Library/Application Support/foundry/projects/<projectHash>/trace.db`.
- Also on disk under the project: prompt dumps, raw JSONL, envelope files, handoffs (raw record; the db is the queryable mirror).
- Run statuses: `running` | `accepted` | `rejected` | `failed` | `killed`.
- Archive is a triage flag the UI may set; it does not delete the trace.

Deeper schema and writer rules: [Trace](../systems/trace.md).

## Related

- [Envelopes and gates](envelopes-and-gates.md)
- [Worktrees](worktrees.md)
- [Pipelines](pipelines.md)
- [Renderer](../systems/renderer.md)
- [Trace](../systems/trace.md)
- [Engine](../systems/engine.md)

## Active contributors

Foundry maintainers.
