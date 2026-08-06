# Foundry desktop

Foundry is a native macOS Electron app that runs repeatable agent-plus-code pipelines against your git repositories. You describe work, pick or design a pipeline, and a deterministic TypeScript engine in the main process sequences bounded agent phases, code commands, and optional human interrupts. Every event lands in a per-project SQLite trace that the UI polls live.

This page is the product overview of the only app in the repository (`apps/desktop/`). Subsystem detail lives under [Systems](../systems/index.md). Operator-facing capabilities live under [Features](../features/index.md).

## What it is

A control room plus the factory itself, in one window:

1. **Describe** — type a request, pick a pipeline (or design one).
2. **Run** — the engine executes phases in order: agent phases via Factory's droid CLI, code phases as plain subprocesses. Retries and corrections reuse the same live droid session.
3. **Watch** — a swim-lane waterfall, tool calls mid-phase, envelopes and gate evidence per phase, token and cost meters filling in real time.
4. **Judge** — the run ends `accepted` or not by its own declared acceptance criterion, with a native notification, outcome banner, and a full queryable trace.

Target maturity is past POC and short of full shipping product: real engine, real settings, real error states, packaged DMG. Auto-update, notarization, multi-machine sync, and cloud services are out of scope.

## Process topology

```
Foundry.app (Electron, macOS 26+)
├── Main (Node, TypeScript)
│   ├── engine/     pipeline executor, envelopes, gates, boundaries, worktrees
│   ├── droid/      long-lived droid exec (stream-JSON-RPC), catalog, one-shot fallback
│   ├── trace/      better-sqlite3 WAL, single writer of run state
│   ├── store/      JSON settings, roster, pipelines, projects
│   ├── system/     process registry, doctor, notifications
│   └── ipc.ts      entire typed invoke/handle surface
├── Preload (bridge.cjs)
│   └── named invoke only; sandboxed, no generic escape hatch
└── Renderer (React 18)
    └── screens + polling stores; never touches disk, git, or droid
```

Hard rules:

- The renderer never touches disk, git, or droid. Everything crosses IPC.
- The tracer is the single writer of run state. Live view and history are the same cursor query.
- Every run gets a git worktree and a `foundry/{runId}` branch by default; the base checkout is not mutated by the engine.
- A phase is born `fail` and flips to success only when exit, envelope, and gates earn it.

Full diagrams and invariants: [Architecture](../overview/architecture.md).

## Screens

| Screen | Role |
|---|---|
| [Onboarding](../features/onboarding.md) | Doctor checks, engineer name, first project. Shown until `settings.onboarded`. |
| [Runs](../features/runs-and-traces.md) | Home: composer (request + pipeline + Start), run list with status and age. |
| [Run detail](../features/runs-and-traces.md) | Waterfall, phase drawer, cost table, kill, outcome banner, worktree merge/discard. |
| [Pipelines](../features/pipelines.md) | Designer: phase list, acceptance, validation rail, dry-run prompts. |
| [Roster](../features/roster.md) | Agent cards and editor: model, prompts, write boundary, envelope. |
| Settings | App defaults, project (isolation, merge policy, commands), maintenance (orphan worktrees), Doctor. |

Navigation is a sidebar plus macOS menu items (`menu:view-runs`, `menu:view-pipelines`, `menu:view-roster`, `menu:settings`, `menu:new-run`, `menu:add-project`).

## Packaging

Configured in `apps/desktop/electron-builder.yml` and `package.json`:

| Item | Value |
|---|---|
| Product | Foundry (`com.foundry.app`) |
| Platform | macOS only |
| Architecture | arm64 |
| Artifact | DMG (`Foundry-*-arm64.dmg` under `apps/desktop/dist/`) |
| Minimum OS | 26.0 (`minimumSystemVersion`) |
| Icon | `assets/icon/app-icon.icns` |
| Category | Developer tools |
| Hardened runtime | on |

Build from `apps/desktop/`:

```bash
npm run package   # build + icons + electron-builder --mac --arm64
```

Native `better-sqlite3` is unpacked from the asar; app assets are copied as `extraResources` so main can resolve them under `process.resourcesPath/assets`.

Auto-update and notarization are not part of the current packaging path. See [Getting started](../overview/getting-started.md).

## State on disk

App support root: `~/Library/Application Support/foundry/`.

- Settings, global roster, and pipelines as JSON.
- Per project: `projects/<hash>/trace.db` (hash of the project path), optional project roster/pipeline overrides under `project-overrides/`.
- Worktrees live in the target repo at `.foundry-worktrees/{runId}`, not under app support.

## Related

### Systems

- [Engine](../systems/engine.md)
- [Droid harness](../systems/droid.md)
- [Trace](../systems/trace.md)
- [Store](../systems/store.md)
- [IPC and preload](../systems/ipc-and-preload.md)
- [System services](../systems/system-services.md)
- [Renderer](../systems/renderer.md)

### Features

- [Pipelines](../features/pipelines.md)
- [Roster](../features/roster.md)
- [Runs and traces](../features/runs-and-traces.md)
- [Envelopes and gates](../features/envelopes-and-gates.md)
- [Worktrees](../features/worktrees.md)
- [Onboarding](../features/onboarding.md)

### Primitives and background

- [Primitives](../primitives/index.md)
- [Design invariants](../background/design-invariants.md)
- [From SSSF to Foundry](../background/from-sssf-to-foundry.md)

## Active contributors

Foundry maintainers.
