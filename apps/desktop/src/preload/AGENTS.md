# src/preload

The preload is a narrow, named capability bridge: `bridge.ts` emits
`bridge.cjs` and exposes explicit wrappers for each `IPC.*` constant. The CJS
output is required because the sandboxed preload cannot be ESM.

Do not add `invoke(channel, ...args)` or business logic here. Add capabilities
through the shared IPC contract and the main router, then expose the smallest
typed wrapper needed by the renderer. The IPC directory guide defines the
canonical flow.
