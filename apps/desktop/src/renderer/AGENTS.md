# AGENTS.md — src/renderer

React 19, unprivileged. Never touches disk, git, or CLIs — everything goes
through `src/shared/ipc-contract.ts` + preload bridge. Polls trace; four
push channels only (`runs-changed`, `interrupts-changed`, `settings-changed`,
`updater-status`).

## Invariants

- No imports from `src/main/`. Add an IPC channel instead.
- IPC args go through `plain()` in `api.ts` — structured-clone failures
  surface only as a button that appears to do nothing.
- Polling + cursor merging lives in `stores/run.tsx`; cost/duration/model are
  derived from events in `derive.ts`, not stored.
- `BrandIcon.tsx`: import `.../components/Color.js` or `Mono.js` directly —
  never the brand's default export (drags `@lobehub/ui` + antd + emoji-mart).
  Droid's mark is an inline SVG; lobehub's `ProviderIcon` misses kimi/zai/
  junie/codex/grok/droid and would show the same placeholder for all. The map
  is written out, not inferred.
- Structural tokens in `design/tokens-base.css`, colours in
  `design/tokens-{prism,murmur}.css`. Exactly one brand sheet is imported, in
  `main.tsx`, chosen from `?brand=` which main puts on the URL before the
  window exists. Never import a brand sheet from a component: a Prism build
  must not ship Murmur's palette. No emoji in UI copy.
- Brand is fixed per window (switching requires a relaunch). Read it with
  `useBrand()`, never from settings, which lags the window by a restart.
