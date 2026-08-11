# AGENTS.md — apps/desktop

Run everything from this directory, not the repo root.

## Commands

- `npm run dev`/`build`/`typecheck`/`lint`/`format:check`/`knip`/`test`
- `npm run check` — all of the above + `build` + `audit:deps`. Must pass
  before you finish; CI enforces the same. Don't skip or deselect failing tests.
- `npm run dev:showcase` — the Pipelines redesign review page on :5175. Serves
  both candidate screens live against a seeded in-memory backend
  (`src/renderer/showcase/`). Review surface only: not routed from the app, not
  packaged, and deleted with the losing option once a direction is picked.

## Gotchas

- `.npmrc` pins `allow-scripts = electron,esbuild,better-sqlite3`. If
  `electron/dist` is missing after install, run `node node_modules/electron/install.js`.
- Preload builds as `bridge.cjs` (CJS) because sandboxed preloads cannot be ESM.
- Path aliases `@shared`/`@main`/`@renderer` are wired in both
  `electron.vite.config.ts` and `tsconfig.json`.
- State lives at `~/Library/Application Support/foundry/`, sharded per project.

## Transports &amp; SDK boundary

- `src/main/droid/sdk/` is the **only** place `@factory/droid-sdk` may be imported (ESLint `no-restricted-imports`; `tests/sdk-*.test.ts` are the one other exception). Everything above it speaks `droid/turn.ts` / `droid/protocol.ts` notification types — not SDK types.
- Final chain: `daemon` (default) → `rpc` (subprocess `SdkSession`) → `oneshot`; two protocol strikes → `oneshot`; daemon unavailable → traced `fallback to subprocess` and the run continues.
- Settings knobs: `compactionThreshold` (0.8, 0.5–0.95), `rewindAfterCorrections` (2, 0 disables), `transport` (daemon/subprocess, default daemon), `daemonPort` (37643 inside 37600–37699).

## Tests

Vitest, real git temp repos + `tests/fake-droid.ts` (plus scripted in-memory transports for SDK unit tests in `tests/sdk-*.test.ts`). No network, no model for unit tests; real `droid` CLI + `custom:meta:muse-spark-1.2` only for soak/engine-demo flows.
New engine behavior needs a test in this style — don't mock git.
