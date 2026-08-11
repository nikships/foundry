# src/renderer

React 19 is unprivileged: no disk, git, CLI, or `src/main/` imports. Use the
shared contract and preload bridge; IPC arguments go through `plain()` in
`api.ts` so structured-clone errors are visible.

Trace polling and cursor merging live in `stores/run.tsx`; event-derived
cost/duration/model data belongs in `derive.ts`, not a denormalized column.
A new event needs a `TranscriptEntry` switch case in
`inspector/entries.tsx`, or the default silently drops it.

The web preview is backed by `src/renderer/mockFoundry.ts` when
`window.foundry` is absent. Keep the mock in sync with new API methods and do
not import Node/main behavior into it. `vite.web.config.ts` uses CSS modules
with `localsConvention: 'camelCase'`; the production CSS collision check is a
real gate. Vitest runs the Node suites in a `forks` pool, so renderer tests
must account for that environment rather than assuming a browser DOM.

Push channels include `runs-changed`, `interrupts-changed`,
`settings-changed`, `updater-status`, `detection-progress`, and
`setup-progress`; the last two are progress for work that has no trace rows.
Factory tokens are statically imported in `main.tsx`; keep provider icons and
CSS imports narrow to avoid pulling unwanted UI bundles.
