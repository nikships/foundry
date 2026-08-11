# AGENTS.md — src/renderer

React 19 renderer. Unprivileged: no `fs`, `child_process`, `electron`, or `src/main/` imports. Everything privileged goes through the typed IPC seam (`src/shared/ipc-contract.ts` → `src/preload/bridge.ts` → `src/renderer/api.ts` via `plain()`).

## Project Overview

- **React 19 + Vite + CSS Modules** (`localsConvention: 'camelCase'` — `.phase-edge` → `styles.phaseEdge`).
- App shell: `App.tsx` + screens (`screens/`), components (`components/`), design tokens (`design/tokens.css`, `tokens-base.css`), hooks, stores, and `pipeline-view.ts`.
- Bridge: `api.ts` wraps `window.foundry` and eagerly `plain()`-clones args so structured‑clone errors are visible before IPC.
- Trace consumption: `stores/run.tsx` polls `runs:events` with a `change_id` cursor and merges by `eventId`; `derive.ts` derives cost/duration/model from events (no denormalized columns). `inspector/entries.tsx` renders `TranscriptEntry` per event — new events need a switch case or the default silently drops them.
- Mock: `mockFoundry.ts` backs `window.foundry` when `window.foundry` is absent (vite web preview). Keep it in sync with `FoundryApi`; do not import Node/main behavior into it.
- Factory tokens imported statically in `main.tsx`; keep provider icon + CSS imports narrow.

## Setup Commands

```bash
npm ci

# Full Electron (renderer served by electron-vite, with HMR)
npm run dev

# Plain browser preview — no Electron, fast UI iteration
npm run dev:web             # vite --config vite.web.config.ts
npm run build:web && npm run preview:web
```

`mockFoundry.ts` is active in the web preview; the Electron app uses the real `window.foundry` from the preload.

## Development Workflow

- Keep CSS in `.module.css` files. Inline `<style>` blocks must not redefine base classes (`.btn`, `.field`, `.hint`, … from `design/tokens-base.css`) — `npm run check:css` fails the build if they do.
- Don't add `src/main/` imports here — use `api.ts`.
- For new trace events: update `derive.ts`, add a `TranscriptEntry` branch in `inspector/entries.tsx`, and ensure `stores/run.tsx` merging handles it.
- `stores/run.tsx` owns polling + cursor merge; `pipeline-view.ts` / hooks own pipeline draft state.

## Testing Instructions

```bash
npm test
npm run test:watch
npx vitest run -t "<renderer|transcript|pipeline-view|keyboard>"
```

- Vitest runs with `pool: forks`, `environment: node`. Renderer tests must account for the Node/forks environment rather than assuming `jsdom`/browser DOM.
- Keep UI tests focused on hooks/stores/derivation; prefer manual verification in `npm run dev:web` for visual work.

## Push Channels

Exactly six main→renderer channels (subscribed via `window.foundry.on`):

- `runs-changed`, `interrupts-changed`, `settings-changed`, `updater-status`, `detection-progress`, `setup-progress`

The last two carry progress for work with no trace rows (detection/setup). Ordinary run data is **polled** via `change_id`, not pushed. Keep `mockFoundry.ts` in sync when adding channels.

## Code Style

- CSS modules with `camelCase`; never redefine base tokens in component style blocks.
- No `eslint-disable` comments — fix the real issue.
- Narrow icon/CSS imports to avoid pulling full UI bundles (see `main.tsx`).
- IPC args must go through `plain()` in `api.ts`.

## Build and Deployment

```bash
npm run build         # includes renderer build (chunked: react-vendor, icons)
npm run check:css     # CSS collision gate (real failure, not advisory)
npm run build:web     # web-only bundle (out/web)
```

- `electron.vite.config.ts` chunks `node_modules` (`react-vendor`, `icons`) and enforces CSS-module conventions.
- Factory design tokens in `design/tokens*.css` are statically imported.

## Additional Notes

- `keyboard.ts` / `local-store.ts` provide shared UI helpers; keep them side‑effect free.
- When changing `FoundryApi`, update `mockFoundry.ts`, `api.ts`, and `src/shared/ipc-contract.ts` together.
