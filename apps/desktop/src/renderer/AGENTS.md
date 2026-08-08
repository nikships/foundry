# AGENTS.md — src/renderer

React 19, unprivileged. Never touches disk, git, or CLIs — everything goes
through `src/shared/ipc-contract.ts` + preload bridge. Polls trace; five
push channels only (`runs-changed`, `interrupts-changed`, `settings-changed`,
`updater-status`, `detection-progress` — the last because a command detection
has no trace rows and so no `change_id` cursor to poll).

## Invariants

- No imports from `src/main/`. Add an IPC channel instead.
- IPC args go through `plain()` in `api.ts` — structured-clone failures
  surface only as a button that appears to do nothing.
- Polling + cursor merging lives in `stores/run.tsx`; cost/duration/model are
  derived from events in `derive.ts`, not stored.
- `BrandIcon.tsx`: import `.../components/Color.js` or `Mono.js` directly —
  never the provider's default export (drags `@lobehub/ui` + antd + emoji-mart).
  Droid's mark is an inline SVG; lobehub's `ProviderIcon` misses kimi/zai/
  junie/codex/grok/droid and would show the same placeholder for all. The map
  is written out, not inferred.
- Structural tokens in `design/tokens-base.css`, colours in
  `tokens-prism.css`, all imported statically in `main.tsx`. Prism is the only
  brand. No emoji in UI copy.
