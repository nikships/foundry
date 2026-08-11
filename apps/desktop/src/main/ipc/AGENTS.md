# src/main/ipc

Use one domain router per capability. The IPC capability flow is:
`types.ts` → `ipc-contract.ts` → router here → `preload/bridge.ts` →
`renderer/api.ts` through `plain()`. There is no generic invoke passthrough.

Handlers must surface rejected promises. Long work returns a handle and
progress is observed separately; do not await an agent turn inside a click
handler. `projects:askAgentCommands` returns a `detectionId`, and setup-agent
requests return a `setupId`.

Push channels are exactly `runs-changed`, `interrupts-changed`,
`settings-changed`, `updater-status`, `detection-progress`, and
`setup-progress`. Detection and setup have no trace cursor, so their progress
is pushed; ordinary run data is polled. Keep routers domain-scoped and update
the shared contract before wiring a new channel.
