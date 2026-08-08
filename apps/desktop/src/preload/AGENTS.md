# AGENTS.md — src/preload

Narrow named-invoke bridge (`bridge.ts` → `bridge.cjs`). Sandboxed preloads
cannot be ESM, so the vite config's `format: 'cjs'` is intentional.

No generic `invoke(channel, ...args)` — every channel is an explicit
`ipcRenderer.invoke(IPC.*)` wrapper. That's the auditable capability surface;
keep this file wiring-only, no logic.
