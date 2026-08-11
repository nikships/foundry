# src/shared

Pure types and constants imported by both processes. No `fs`,
`child_process`, `electron`, or React imports.

`types.ts` is the source of truth for pipeline/phase/agent, boundary, run,
event, gate, CLI, project, and settings shapes. Boundary values are `null`
(unrestricted), `[]` (read-only), or an allowlist. `ipc-contract.ts` defines
`FoundryApi` and the `IPC` constants; both sides import those constants so a
rename cannot silently break a call.

For a new capability, add the type, IPC constant, main handler, preload
wrapper, and renderer `api.ts` call in that order. `AgentDef.cli` is optional
and defaults to Droid; keep `CLI_VENDOR_IDS` synchronized with
`src/main/cli/index.ts`.
