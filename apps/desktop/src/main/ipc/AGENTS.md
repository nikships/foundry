# AGENTS.md — src/main/ipc

Domain routers implement the typed IPC seam: shared contract → router → preload wrapper → renderer API. There is no generic channel passthrough.

## Router contract

- Keep one router per domain and keep routers thin: validate arguments, delegate to the owning subsystem, and return clone-safe values.
- `index.ts` builds `MainHandlerRegistry`, registers functions with Electron, and returns a main-only `MainInvoker` for Smith. Never expose that invoker through preload.
- Rejected handlers remain rejected promises so the renderer receives errors.
- Long work returns an ID or handle and reports progress separately.
- Smith maps fixed operation enums to fixed IPC constants. Never accept a model-provided channel string or dispatch from capability coverage metadata.

When adding a capability, update the shared contract first, then the router, preload wrapper, renderer API, and surface tests.

## Push channels

Main-to-renderer channels are:

`runs-changed`, `settings-changed`, `updater-status`, `detection-progress`, `setup-progress`, `orchestrator-progress`, `smith-proposals-changed`, `smith-progress`, `bridge-changed`, and `companion-changed`.

Run events are polled with the trace cursor, not pushed. Update this list, preload, renderer subscriptions, and `mockFoundry.ts` together when changing channels.

## Validation

```bash
npx vitest run apps/desktop/tests/main/ipc/ipc-surface.test.ts
npx vitest run apps/desktop/tests/main/ipc/ipc-clone.test.ts
npx vitest run apps/desktop/tests/main/ipc/ipc-invoker.test.ts
```
