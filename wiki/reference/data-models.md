# Data models

Core TypeScript contracts and SQLite tables. Source of truth for TS shapes: `apps/desktop/src/shared/types.ts`. Schema: `apps/desktop/src/main/trace/db.ts`.

## Pipeline and phase (TypeScript)

```text
PipelineDef
  id, name, description
  acceptance: Acceptance
  phases: PhaseDef[]
  isolation?: boolean
  builtin?: boolean

PhaseDef
  name, kind: agent | code | engineer
  description
  agent?, envelope?, gates?, prompt?
  command?, retries?, feedbackTo?, feedbackRetries?
  question?, timeoutMs?, optional?
```

`Acceptance` variants include `phase_flag`, `all_phases_pass`, `last_phase_pass`, `envelope_status`.

## Agent

```text
AgentDef
  name, purpose, model, reasoningEffort
  systemPrompt, userPrompt
  writes: string[] | null
  envelope: EnvelopeKind
  customFields?, tools?, disabledTools?
  color, emblem?, builtin?
```

## Envelope kinds

`generic` | `plan` | `build` | `scout` | `review` | `document`

Base conceptual fields: `status`, `summary`, `artifacts[]`, `notes_for_next_agent`, plus kind-specific fields (e.g. `changed_files`, `approved`, `findings`). Zod lives in `engine/envelopes.ts`.

## SQLite tables

| Table | Role |
|---|---|
| `runs` | One row per run; status, worktree, branch, costs, outcome_detail |
| `phases` | Per phase; **status defaults fail**; attempts |
| `events` | Append-only stream; polled by rowid |
| `envelopes` | Parsed/invalid agent reports per attempt |
| `gate_results` | Gate name, passed, checks_json |
| `agent_sessions` | droid session id, model, mode rpc\|oneshot |
| `processes` | PIDs for kill and orphan sweep |
| `migrations` | Schema version |

Phases do not store denormalized per-attempt token totals for UI; the renderer derives cost from events (`renderer/derive.ts`).

## IPC payloads

`RunDetail`, `EventPage`, `SaveResult<T>`, `FoundryApi` method shapes: `src/shared/ipc-contract.ts`.

## State locations

| Data | Location |
|---|---|
| Trace db | `~/Library/Application Support/foundry/projects/<hash>/trace.db` |
| App settings / roster / pipelines JSON | Application Support foundry store files |
| Run file artifacts | Under project / worktree runs paths as written by engine |
| Worktrees | `{repo}/.foundry-worktrees/{runId}` |
