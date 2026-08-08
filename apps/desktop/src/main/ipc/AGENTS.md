# AGENTS.md — src/main/ipc

One router per domain for channels declared in `src/shared/ipc-contract.ts`.
Renderer never touches disk/git/droid except through here.

Add a capability: type in `types.ts` → channel in `ipc-contract.ts` →
handler here → expose in `preload/bridge.ts` → call via `api.ts` (through
`plain()`). No generic `invoke(channel)` passthrough.

Handlers that can reject must surface the error — silent rejection looks like
a dead button. Keep routers domain-scoped; push channels are only `runs-changed`,
`interrupts-changed`, `settings-changed`, `updater-status`,
`detection-progress` — everything else is polled.

A handler that starts long work returns a handle, not the result: awaiting a
five-minute agent turn inside a click leaves a button that looks dead and a
rejection with nowhere to land. `projects:askAgentCommands` returns a
`detectionId` and progress arrives on `detection-progress`.
