# AGENTS.md — apps/desktop

This directory is the entire Foundry Electron application. All app commands run here, not from the repository root.

## Project Overview

- **Electron 43 + Vite (electron-vite) + React 19 + TypeScript 6 (strict)**
- Three bundles: `main` (Node, ES, minified), `preload` (`bridge.cjs`, CJS, sandboxed), `renderer` (React, CSS modules with `localsConvention: 'camelCase'`).
- Process split: `src/main/` owns git/disk/CLIs/SQLite; `src/renderer/` is unprivileged and talks to main only via `src/shared/ipc-contract.ts` → `src/preload/bridge.ts` → `src/renderer/api.ts` (through `plain()`).
- Path aliases (`electron.vite.config.ts` + `tsconfig.json`): `@shared/*`, `@main/*`, `@renderer/*`.
- State lives under `~/Library/Application Support/foundry/` (sharded per project).

## Setup Commands

```bash
cd apps/desktop
npm ci
# If Electron's distribution is absent after install (allowed-scripts gate):
node node_modules/electron/install.js
```

`.npmrc` allow‑lists install scripts only for `electron`, `esbuild`, `better-sqlite3`. Do not add `allow-scripts` entries without updating this file.

## Development Workflow

```bash
cd apps/desktop
npm run dev                 # Electron with HMR (electron-vite dev)
npm run build               # production build (main + preload + renderer, esbuild minified)
npm run start               # preview built bundle

# Renderer-only in a plain browser — no Electron, fast UI iteration
npm run dev:web             # vite --config vite.web.config.ts
npm run build:web           # vite build --config vite.web.config.ts
npm run preview:web         # serve last web build
```

- `electron.vite.config.ts` externalizes Node deps for `main`/`preload` and controls chunking (`react-vendor`, `icons`).
- `vite.web.config.ts` provides the browser preview; `src/renderer/mockFoundry.ts` backs `window.foundry` when Electron is absent — keep it in sync with `FoundryApi`.
- Preload output must stay CJS (`out/preload/bridge.cjs`); sandboxed preloads cannot be ESM.
- Resolve the GUI environment (`src/main/system/env.ts:resolveEnv()`) before any CLI spawn — see `src/main/system/AGENTS.md`.

Convenience from repo root: `make dev`, `make build`, `make web`, `make check`.

## Testing Instructions

- Framework: **Vitest 4**, `pool: forks`, `environment: node`, 30s timeout (`vitest.config.ts`).
- Suites: `tests/**/*.test.ts`.

```bash
cd apps/desktop
npm test                          # vitest run (all)
npm run test:watch                # watch mode
npx vitest run -t "<pattern>"     # filter by name
npx vitest run tests/executor.test.ts  # single file
```

Conventions:

- Use **real git temp repos** and `tests/fake-droid.ts` (real child handshake fixture). Never use a network/model; do not mock git. New engine behavior should follow `tests/executor.test.ts` rather than stubbing `git`.
- `tests/cli-vendors.test.ts` owns CLI adapter fixtures.
- Vitest inlines `@lobehub/icons` via `server.deps.inline` — bare specifiers would fail in Node ESM otherwise.
- Changing test isolation? Read `vitest.config.ts` first.

## Code Style

```bash
cd apps/desktop
npm run typecheck           # tsc --noEmit -p tsconfig.json
npm run lint                # eslint . --max-warnings 0
npm run lint:fix            # eslint . --fix
npm run format:check        # prettier --check .
npm run format              # prettier --write .
npm run knip                # dead code / unused exports
```

- TypeScript `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`.
- ESLint flat config (`eslint.config.js`): `typescript-eslint` + `eslint-plugin-react` + `eslint-plugin-react-hooks`, `no-restricted-imports` for `@factory/droid-sdk` (only `src/main/droid/sdk/**` may import it). Never use `eslint-disable` — fix the real issue.
- Prettier is enforced; `eslint-config-prettier` runs last.
- `no-console` is `warn` (allow `warn`/`error`); `scripts/**/*.ts` is exempt.

## Build and Deployment

```bash
cd apps/desktop
npm run build               # electron-vite build
npm run check:css           # fail if inline <style> redefines tokens-base.css classes
npm run audit:deps          # npm audit --audit-level=high in clean env
npm run check               # typecheck + lint + format:check + knip + test + build + check:css + audit:deps
npm run package             # build + icons + electron-builder --mac --arm64 (local DMG)
```

- `check:css` (`scripts/check-css-collisions.mjs`) enforces CSS-module ownership — inline `<style>` must not redefine base classes (`.btn`, `.field`, … from `design/tokens-base.css`). Move to `.module.css`.
- `audit:deps` (`scripts/audit-deps.mjs`) strips `npm_config_allow_scripts` so `npm audit` works on npm 12 locally and in CI.
- `npm run check` is the required local gate before submitting; CI `verify` runs the same core checks (minus `check:css`).

## Process Boundaries

- **Main** owns privilege; **renderer** has no `fs`/`child_process`/`electron`/`src/main/` imports.
- **`src/main/droid/sdk/` is the sole `@factory/droid-sdk` import boundary** (SDK tests are the exception). Above it, use `droid/turn.ts` and protocol notification types. Transport chain: daemon (default) → RPC subprocess → one-shot fallback.
- Aliases must stay in sync between `electron.vite.config.ts` and `tsconfig.json`.

See sibling guides for detail: `src/main/`, `src/preload/`, `src/renderer/`, `src/shared/`.
