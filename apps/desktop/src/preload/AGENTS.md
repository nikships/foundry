# AGENTS.md — src/preload

This is the narrow capability bridge between the sandboxed renderer and main. `bridge.ts` emits CJS and exposes explicit wrappers for `IPC.*` constants.

## Contract

- One typed wrapper per capability in `src/shared/ipc-contract.ts`.
- Use `contextBridge` and `ipcRenderer`; keep business logic out.
- Never add generic `invoke(channel, ...)` forwarding.
- Output must remain `out/preload/bridge.cjs`. Sandboxed preloads cannot be ESM.

## Adding a capability

1. Add shared types and the `IPC.*` constant.
2. Add the main-process domain handler.
3. Add the smallest typed wrapper in `bridge.ts`.
4. Call it from `renderer/api.ts` through `plain()`.

Menu commands are one-way `foundryMenu` subscriptions, not invoke channels.

## Validation

```bash
npx vitest run apps/desktop/tests/main/ipc/ipc-surface.test.ts
npx vitest run apps/desktop/tests/main/ipc/ipc-clone.test.ts
```

Surface tests verify that every IPC constant has a wrapper and payloads survive `structuredClone`.
