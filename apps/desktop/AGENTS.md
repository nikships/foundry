# apps/desktop

Run commands from this directory, not the repository root.

## Checks and install

`npm run check` is the required gate: typecheck, lint, format check, Knip,
Vitest, Electron build, `check:css`, and `audit:deps`. `.npmrc` allows install
scripts only for `electron`, `esbuild`, and `better-sqlite3`; if Electron's
distribution is absent after install, run
`node node_modules/electron/install.js`.

Tests use real git temporary repositories and `tests/fake-droid.ts`; unit tests
never use a network or model. New engine behavior should follow that style
rather than mocking git. Vitest uses the `forks` pool; see
`vitest.config.ts` before changing test isolation.

## Process boundaries

The main process owns privileged work; renderer code uses the shared IPC
contract and preload bridge. The preload output must stay CJS (`bridge.cjs`)
because sandboxed preloads cannot be ESM. Aliases are configured in both
`electron.vite.config.ts` and `tsconfig.json`.

`src/main/droid/sdk/` is the only production import boundary for
`@factory/droid-sdk` (SDK tests are the documented exception). Code above it
uses `droid/turn.ts` and protocol notification types. The transport chain is
daemon (default) → RPC subprocess → one-shot fallback; see
the Droid transport directory guide for the failure and permission rules.

State is under `~/Library/Application Support/foundry/`, sharded per project.
Routing details live in the sibling guides for `src/main`, `src/preload`,
`src/renderer`, and `src/shared`.
