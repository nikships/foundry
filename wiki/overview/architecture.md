# Architecture

Foundry is a single Electron process tree: a privileged **main** process (Node), a sandboxed **preload** bridge, and a **renderer** (React 19). The factory engine, droid harness, SQLite tracer, and config stores live only in main. The UI never touches disk, git, or droid directly.

## Process topology

```mermaid
graph TB
  subgraph Foundry["Foundry.app"]
    Main["Main process<br/>engine · droid · trace · store · system · ipc"]
    Preload["Preload bridge.cjs<br/>named invoke only"]
    Renderer["Renderer React 19<br/>polls via IPC"]
    Main <-->|typed IPC| Preload
    Preload <--> Renderer
  end
  Droid["droid exec<br/>stream-JSON-RPC"]
  Code["child_process<br/>test · lint · git"]
  WT["git worktree<br/>foundry/run_*"]
  DB["trace.db WAL<br/>~/Library/Application Support/foundry/"]
  Main -->|spawn per agent| Droid
  Main -->|spawn per code phase| Code
  Main -->|create / merge / discard| WT
  Main -->|single writer| DB
  Renderer -.->|poll events after rowid| Main
```

## Language breakdown (Foundry app)

Approximate source under `apps/desktop/` (excluding `node_modules`, `dist`, `out`):

| Language | Role | ~Lines |
|---|---|---|
| TypeScript / TSX | App + tests | ~13.5k |
| CSS | Design tokens | ~375 |
| Config YAML / JSON | Build and packaging | small |

The SSSF skill (Python, Vue visualizer templates) lives under `.claude/skills/sssf/` and is not part of the app runtime. See [From SSSF to Foundry](../background/from-sssf-to-foundry.md).

## Main process layout

| Directory | Responsibility |
|---|---|
| `src/main/engine/` | Pipeline executor, envelopes, gates, write boundaries, worktrees, prompts |
| `src/main/droid/` | Long-lived `droid exec` client, protocol, event folding, catalog, one-shot fallback |
| `src/main/trace/` | better-sqlite3 schema + `Tracer` (only writer of run state) |
| `src/main/store/` | JSON-backed settings, roster, pipelines, projects; builtins as seeds |
| `src/main/system/` | Process registry, doctor checks, native notifications |
| `src/main/ipc.ts` | Full invoke/handle surface for the renderer |
| `src/main/main.ts` | Window lifecycle, menu, app bootstrap |

## Shared contract

`src/shared/types.ts` and `src/shared/ipc-contract.ts` are the contract both processes import. If the UI needs a new capability, the channel is added there first, then a handler in `ipc.ts`, then the preload bridge.

## Run data flow

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant IPC as ipc.ts
  participant Ex as Executor
  participant Dr as Droid client
  participant Tr as Tracer / SQLite

  UI->>IPC: runs.start(request, pipeline, project)
  IPC->>Ex: run()
  Ex->>Tr: startRun, startPhase(fail)
  Ex->>Dr: prompt turn (same session on retry)
  Dr-->>Tr: tool_call, usage, agent_end
  Ex->>Ex: parse envelope, run gates, boundary check
  Ex->>Tr: envelope, gate_results, phase success/fail
  loop poll cadence
    UI->>IPC: trace.events(runId, afterRowid)
    IPC->>Tr: SELECT ... rowid > ?
    Tr-->>UI: EventPage
  end
  Ex->>Tr: finish(status) settles banner + notification
```

## Invariants that structure the design

- **A phase is born `fail`.** It flips to success only on clean exit, plus (for agent phases) a parsed envelope and green gates.
- **Corrections re-prompt the same live session.** Envelope retries and gate retries have separate budgets.
- **Gates return evidence, not verdicts.** Each gate emits one `GateCheck` per item examined.
- **Write boundaries are enforced after the call** by diffing `git status`, not by trusting the agent.
- **`finish()`** settles status, notification, banner, and `outcome_detail` together.
- Every run gets a git worktree and a `foundry/run_*` branch by default; the base checkout is never touched.

Deeper subsystem pages: [Engine](../systems/engine.md), [Droid harness](../systems/droid.md), [Trace](../systems/trace.md), [Renderer](../systems/renderer.md).
