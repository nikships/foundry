# AGENTS.md — apps/desktop

Run everything from this directory, not the repo root.

## Commands

- `npm run dev` — electron-vite dev (all three bundles)
- `npm run build` — required before `npm start`, emits `out/`
- `npm run typecheck` / `lint` / `format:check` / `knip` / `test`
- `npm run check` — all of the above + `build` + `audit:deps`. Must pass
  before you finish; CI enforces the same. Don't skip or deselect failing tests.

## Gotchas

- `.npmrc` pins `allow-scripts = electron,esbuild,better-sqlite3`. If
  `electron/dist` is missing after install, run `node node_modules/electron/install.js`.
- Preload builds as `bridge.cjs` (CJS) because sandboxed preloads cannot be ESM.
- Path aliases `@shared`/`@main`/`@renderer` are wired in both
  `electron.vite.config.ts` and `tsconfig.json`.
- State lives at `~/Library/Application Support/foundry/`, sharded per project.

## Tests

Vitest, real git temp repos + `tests/fake-droid.ts`. No network, no model.
New engine behavior needs a test in this style — don't mock git.

## Deeper docs

Read the `AGENTS.md` closest to what you're changing:
`src/main/AGENTS.md`, `src/main/engine/AGENTS.md`, `src/main/cli/AGENTS.md`,
`src/main/droid/AGENTS.md`, `src/main/trace/AGENTS.md`, `src/renderer/AGENTS.md`,
`src/shared/AGENTS.md`.
