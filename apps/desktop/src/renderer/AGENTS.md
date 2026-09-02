# AGENTS.md — src/renderer

The React renderer is unprivileged. It never imports Node, Electron, or main-process code; privileged work goes through `api.ts` and the typed preload bridge.

## Architecture

- Use React 19 and CSS Modules with camel-cased locals.
- `App.tsx` owns the shell and lazy screen loading; keep large icon/UI imports scoped to screens.
- `api.ts` wraps `window.foundry` and clone-checks IPC arguments through `plain()`.
- `mockFoundry.ts` supports web preview and must track `FoundryApi`; never import main behavior into it.
- `stores/run.tsx` polls by `change_id` and merges by `eventId`.
- `utils/derive.ts` derives usage, duration, and model from events.
- `components/inspector/entries.tsx` must explicitly render each trace event.
- Smith screen and launcher share optional project scope. Secret inputs and private Companion displays stay component-local and out of chat state.

## Rules

- Keep component styles in `.module.css`. Do not redefine classes owned by `design/tokens-base.css`; `check:css` enforces this.
- New trace events require derivation and an Inspector branch.
- New IPC capabilities require synchronized `FoundryApi`, preload, `api.ts`, and mock changes.
- Push channels must match the list in `src/main/ipc/AGENTS.md`; ordinary run data is polled, not pushed.
- Keep hooks, stores, and view-models responsible for state/derivation rather than embedding it in large components.

Renderer Vitest runs in Node, not jsdom. Focus unit tests on pure view-model, hook, store, and derivation behavior. Use the built Electron smoke or `foundry-ui` for real-window behavior.

## Validation

```bash
npx vitest run -t "renderer|transcript|pipeline-view|keyboard"
npm run check:css
```
