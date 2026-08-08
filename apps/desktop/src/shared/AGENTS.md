# AGENTS.md — src/shared

Pure types + string constants, imported by both main and renderer. No `fs`,
`child_process`, `electron`, or React here.

- `types.ts` is the single source for `PipelineDef`/`PhaseDef`/`AgentDef`/
  `WriteBoundary` (`null` unrestricted, `[]` read-only, list = allowlist),
  run/event/gate shapes, `CliVendor`, `ProjectDef`/`AppSettings`.
- `ipc-contract.ts` is the capability surface: `FoundryApi` + `IPC` const.
  Both sides import the const so a rename can't silently break a call.
  Add a new capability: type in `types.ts` → channel in `ipc-contract.ts` →
  handler in `src/main/ipc/` → expose in `preload/bridge.ts` → call via
  `src/renderer/api.ts` (through `plain()`).

`AgentDef.cli` is optional — absent means `droid`. Keep `CLI_VENDOR_IDS` in
sync with `src/main/cli/index.ts`.
