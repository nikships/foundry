# Dependencies

Runtime and tool dependencies for Foundry (`apps/desktop/package.json`).

## Runtime (npm)

| Package | Role |
|---|---|
| `electron` | App shell |
| `react` / `react-dom` | Renderer UI (18.x) |
| `better-sqlite3` | Trace db (native; asar unpacked) |
| `electron-store` | App settings JSON |
| `zod` | Envelope and validation schemas |

## Dev / build

| Package | Role |
|---|---|
| `electron-vite` / `vite` | Multi-process build |
| `@vitejs/plugin-react` | Renderer |
| `electron-builder` | macOS DMG packaging |
| `typescript` | Types and `tsc --noEmit` |
| `vitest` | Tests |
| `tsx` | Run `engine-demo.ts` |
| `@types/*` | Node, React, sqlite types |

Versions move with the lockfile; this table is purpose-oriented.

## External binaries

| Tool | Role |
|---|---|
| `droid` (Factory CLI) | Agent phases |
| `git` | Worktrees, status, commits |
| Host toolchains | Whatever project commands invoke (`npm test`, `bun test`, etc.) |

## Not dependencies of the app

- Python / `uv` / `pi` (SSSF skill stack)
- Anything under `.claude/`
- Network services for the core loop (tests and engine demo are offline)

## Dependency count signal

`package.json` keeps the direct dependency surface small (single-digit runtime deps). Most bulk is Electron and the lockfile transitive graph under `node_modules/`.
