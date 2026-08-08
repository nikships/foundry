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
- Design tokens in `design/tokens.css`. No emoji in UI copy.
