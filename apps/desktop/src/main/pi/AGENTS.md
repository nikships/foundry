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
- `packages.ts` declares the pi packages this build ships and resolves them to loadable paths.

Do not import pi’s transitive packages directly. Derive needed types from `pi-coding-agent`’s public surface.

## Invariants

- **Never touch `~/.pi`.** Pin runtime, auth, catalog, and session paths under Foundry’s support directory.
- **Discovery stays off.** Extensions, skills, prompt templates, themes, context files, and appended system prompts do not come from the user’s pi installation.
- **Packages ship with the app.** `BUNDLED_PACKAGES` in `packages.ts` is the whole list, vendored under `resources/pi-packages/` and copied out by `extraResources` (jiti reads an extension from disk, and an asar path is not a file). There is no install path: nothing at runtime — no operator, agent, plan, or repository — adds a package. Adding one is a source change plus a release.
- **Package resources are named, never discovered.** Resolved paths reach a session through `additionalExtensionPaths` / `additionalSkillPaths` while every `no*` flag stays true. Resolution uses `cwd = supportDir` and `projectTrusted: false`, so a checkout’s `.pi/` contributes nothing and a run does not change behavior based on which repository is open.
- **A read-only profile takes skills, not extension tools.** A skill instructs; an extension hands over a capability. The engine verifies a review phase wrote nothing by diffing git afterwards, so a write-capable package tool reaching one breaks that check. Override per package with `extensionsForReadOnly` only when the package is genuinely read-only.
- **Package tool names are read after `reload()` and before `createAgentSession`,** because that array is the registry allowlist — a loaded tool absent from it does not exist. They are derived from what loaded, not gated a second time: resolution already decided which extensions a profile may have, and a second switch could only disagree with it. The policy’s `package` category allows them on the same footing as `command`, while `unknown` stays fail-closed for anything unattributed.
- Read `references/packages.md` before changing package resolution.
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
- Model fallback records the model that actually ran and skips operator-hidden failover targets.
- Callers verify claims independently: repair checks Git and command detection executes proposed commands.

## Tests

Most suites use `scripted-transport.ts` or `scripted-oneshot.ts` and never load a provider. Adapter tests replace the vendor session; runtime tests use a temporary state directory and assert `~/.pi` remains untouched.

```bash
npx vitest run -t "pi"
npx vitest run apps/desktop/tests/main/pi/pi-packaging.test.ts
npx vitest run apps/desktop/tests/main/engine/executor.test.ts
```
