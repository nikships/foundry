# AGENTS.md — src/main/pi

This directory owns every model call and is the only place allowed to import `@earendil-works/pi-*`. Pi runs in-process, not through RPC, a child process, or MCP.

Before changing this integration, read `references/README.md`, then the vendored SDK or extension document relevant to the change. Do not consult live upstream docs because the package is exact-pinned and upstream may differ.

## Architecture

- `transport.ts` and `oneshot.ts` are vendor-neutral contracts imported by the rest of Foundry.
- `pi-transport.ts` and `pi-oneshot.ts` adapt those contracts to pi. Vendor types stop there.
- Run sessions persist across turns; one-shots own one turn and dispose in `finally`.
- `open-session.ts`, policy extensions, tool definitions, model selection, vendor event translation, and transcript folding are shared so session types do not drift.
- Lazy wrappers defer loading the vendor package until the first turn.
- `runtime.ts` owns the memoized runtime under Foundry Application Support.
- `catalog.ts` owns reachable models and credential operations.
- `direct-providers.ts` registers the providers pi's own table lacks, from `shared/direct-providers.ts`.

Do not import pi’s transitive packages directly. Derive needed types from `pi-coding-agent`’s public surface.

## Invariants

- **Never touch `~/.pi`.** Pin runtime, auth, catalog, and session paths under Foundry’s support directory.
- **Discovery stays off.** Extensions, skills, prompt templates, themes, context files, and appended system prompts do not come from the user’s pi installation.
- **Install the Foundry identity as system context.** The phase ask remains the user message.
- **The tool list is the capability boundary.** A read-only session has no write or shell tool, not merely a policy denial. Preserve a narrow `git_diff` replacement where review work needs it.
- **Every tool call receives a verdict.** Unknown tools fail closed. Engine post-call diffing remains the final write-boundary enforcement.
- Bind policy extensions before the first prompt.
- A structured one-shot result is only a candidate; caller-owned schema and domain validation remain authoritative.
- Agent turns have no Foundry timeout. They end on provider completion/failure or explicit cancellation.
- Swap envelope tool definitions between turns rather than mutating schemas; pi caches validators by schema identity.
- Compaction and rewind reuse the same session. Pi rewinds conversation only; the engine restores files.
- Resolve run worktree paths fail-closed. Never fall back to `process.cwd()`.
- Keep runtime imports free of unguarded native bindings. The packaging test blocks `dlopen`; add `asarUnpack` only when a required binding is proven.
- `PI_OFFLINE=1` is read when constructing `ModelRuntime`; offline refreshes must not allow network.
- Persistent direct API keys use the catalog login path. In-memory overrides must not be described as durable.
- A provider absent from pi's table is registered on the runtime before it is handed out, never written into `models.json`, which the operator and the Bridge own. Registration carries no credential, so such a provider stays out of `getAvailable()` until a key is stored. Its models are pinned in `shared/direct-providers.ts` because the vendor endpoint reports ids alone.
- Model fallback records the model that actually ran and skips operator-hidden failover targets.
- Callers verify claims independently: repair checks Git and command detection executes proposed commands.

## Tests

Most suites use `scripted-transport.ts` or `scripted-oneshot.ts` and never load a provider. Adapter tests replace the vendor session; runtime tests use a temporary state directory and assert `~/.pi` remains untouched.

```bash
npx vitest run -t "pi"
npx vitest run apps/desktop/tests/main/pi/pi-packaging.test.ts
npx vitest run apps/desktop/tests/main/engine/executor.test.ts
```
