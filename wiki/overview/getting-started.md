# Getting started

How to run Foundry from source on a Mac, exercise the headless engine, and package a DMG.

## Prerequisites

| Tool | Why |
|---|---|
| macOS (target floor 26.0 for packaged app) | Native window, vibrancy, notifications |
| Node.js 22+ | Main process and tooling |
| npm | Installs under `apps/desktop/` |
| git | Worktrees, boundary checks, commit builtins |
| [Factory droid CLI](https://factory.ai) on `PATH` | Agent phases spawn `droid exec` |
| Factory auth / API key as droid expects | Doctor surfaces missing auth |

Python, `pi`, and the SSSF skill are **not** required to run Foundry.

## Install

```bash
cd apps/desktop
npm install
```

`.npmrc` pins `allow-scripts = electron,esbuild,better-sqlite3`. If `electron/dist` is missing after install:

```bash
node node_modules/electron/install.js
```

## Develop

Run everything from `apps/desktop/`:

```bash
npm run dev         # electron-vite dev (main + preload + renderer)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # required before npm start; emits out/{main,preload,renderer}
npm start           # electron-vite preview of the built app
npm run engine:demo # headless engine against a temp git repo (no UI)
```

**Before finishing a change, all three must pass:** `npm run typecheck`, `npm test`, `npm run build`.

## Package

```bash
npm run package   # build + icons + electron-builder --mac --arm64
```

Produces a DMG under `apps/desktop/dist/`. Auto-update and notarization are out of scope for the current maturity target (see `PLAN.md`).

## First run in the app

1. Launch via `npm run dev`.
2. Onboarding runs Doctor: droid on PATH, auth, git, OS version.
3. Add a project (folder picker; must be a git repo).
4. Set project commands (`test`, `lint`, …) and use **Try it**.
5. Optional smoke: run the built-in `scout` pipeline (read-only agent).

State lives under `~/Library/Application Support/foundry/`, sharded per project by a hash of the project path (`projects/<hash>/trace.db`).

## Repo layout (what you edit)

```
apps/desktop/
├── src/main/       engine, droid, store, system, trace, ipc, main
├── src/preload/    bridge.ts → bridge.cjs
├── src/renderer/   React screens and components
├── src/shared/     types.ts + ipc-contract.ts
├── tests/          vitest, real git temp repos, fake-droid
└── scripts/        engine-demo.ts, make-icns.sh
```

See [Development workflow](../how-to-contribute/development-workflow.md) and [Testing](../how-to-contribute/testing.md) for day-to-day contribution habits.
