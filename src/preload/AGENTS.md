# AGENTS.md — src/preload

Narrow, named capability bridge between the sandboxed renderer and the main process. `bridge.ts` emits `out/preload/bridge.cjs` and exposes explicit wrappers for each `IPC.*` constant — no generic `invoke(channel, ...)` escape hatch.

## Project Overview

- One typed wrapper per `IPC.*` entry in `src/shared/ipc-contract.ts`. The renderer's capabilities are exactly this list.
- `ghostty.ts` is the one exception and does **not** go through the bridge: it speaks the vendored terminal package's own `electron-ghostty:*` IPC directly, receiving frames via `sharedTexture` and sending key/mouse/IME input back. See `src/main/smith/AGENTS.md`.
- Uses `electron.contextBridge` + `electron.ipcRenderer`. Preload is sandboxed and isolated (`contextIsolation: true`, `sandbox: true` in `src/main/main.ts`).
- Output must stay **CJS** (`bridge.cjs`) — sandboxed preloads cannot be ESM (`electron.vite.config.ts` → `rollupOptions.output.format: 'cjs'`).

## Setup Commands

```bash
npm ci
npm run dev     # rebuilds preload on change and reloads the app
npm run build   # emits out/preload/bridge.cjs
```

No preload-specific setup beyond the app install.

## Development Workflow

To expose a new capability:

1. Define types + an `IPC.*` constant in `src/shared/` (see `src/shared/AGENTS.md`).
2. Add the domain handler in `src/main/ipc/`.
3. Add the smallest typed wrapper in `src/preload/bridge.ts` that calls `ipcRenderer.invoke(IPC.xxx, ...)`.
4. Call it from `src/renderer/api.ts` through `plain()`.

Rules:

- Do not add `invoke(channel, ...args)` forwarding or business logic here.
- Keep the bridge a flat, named list — one method per capability.

## Testing Instructions

```bash
npm test
npx vitest run -t "ipc"
npx vitest run tests/ipc-surface.test.ts
npx vitest run tests/ipc-clone.test.ts
```

- Surface tests assert every `IPC.*` constant has a wrapper and that payloads survive `structuredClone`.

## Code Style

- Preload is authored in TypeScript ESM and built to CJS — keep imports compatible.
- Globals: both `node` and `browser` are allowed here (see `eslint.config.js`).
- No `eslint-disable`; fix the real issue.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build  # emits out/preload/bridge.cjs
```

`electron.vite.config.ts` (`externalizeDepsPlugin()` + `minify: 'esbuild'`) builds this bundle.

## Additional Notes

- The IPC flow is documented in `src/main/ipc/AGENTS.md`: `types.ts` → `ipc-contract.ts` → router → `bridge.ts` → `api.ts` via `plain()`.
- Menu channels (`foundryMenu`) are one-way `on` subscriptions for app menu → renderer (e.g. `Cmd+N`).
