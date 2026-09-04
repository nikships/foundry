# AGENTS.md — src/shared

Shared code is imported by main and renderer. It must remain side-effect free: no `fs`, `child_process`, Electron, or React.

## Ownership

- `types.ts` — pipelines, phases, agents, envelopes, gates, boundaries, runs, projects, and settings.
- `ipc-contract.ts` — `FoundryApi` and `IPC.*` channel constants.
- `builtin-agents.ts` / `builtin-pipelines.ts` — pure shipped seed definitions, not store behavior.
- `model-intelligence.ts` and its vendored data — offline model capability scores.
- `direct-providers.ts` — providers pi's own table lacks, pinned with their models. Shared because main registers under the same id the renderer's key row stores against.

Boundary values are contractual: `null` means unrestricted except protected paths, `[]` means read-only, and allowlists support segment `*` and recursive `**`.

Model IDs are opaque `provider/model` strings. Shared code does not validate them against a vendor catalog.

Smith scope is optional, with absence meaning “All projects.” Secrets and private displays cross only their dedicated approval response or renderer path, never `SmithChatState`.

## Changing the IPC surface

1. Add shared types and an `IPC.*` constant/method.
2. Add the main handler.
3. Add the preload wrapper.
4. Call it from `renderer/api.ts` through `plain()`.

Keep envelope documentation beside its schemas and add schema/parse tests for new envelopes or gates.

## Validation

```bash
npx vitest run -t "ipc|envelope|gate|boundary"
npx vitest run apps/desktop/tests/main/ipc/ipc-surface.test.ts
```
