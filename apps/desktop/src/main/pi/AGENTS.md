# AGENTS.md — src/main/pi

Every agent call in the app, long-lived or one-shot. Pi runs **in this process**: no child process, no wire protocol, no MCP server. This directory is the only place in the app allowed to name `@earendil-works/pi-*`.

**Read the pinned vendor docs in `references/` before changing this directory.** Start at `references/README.md`, then `references/sdk.md` and `references/extensions.md`. Those files are copies of `@earendil-works/pi-coding-agent@0.84.2`. Do not consult live pi.dev or GitHub docs — they may be ahead of the pin. Foundry does not use RPC mode.

Two session shapes live here. A **run** holds a session across many turns (`session.ts` over `transport.ts`). A **one-shot** opens a session, asks one question, and disposes it (`oneshot.ts`); that is detection, setup generation, the run-start command fill, rebase repair, and the readiness fix. They share model selection, event translation, and the tool lists, so the two cannot drift.

## Project Overview

**The long-lived seam**

- `transport.ts` — the vendor-neutral seam. `AgentTransport` plus the neutral event, usage, permission, and rewind types. **Everything above this directory imports from here and nowhere else**, which is what lets the engine and the test fixtures stay ignorant of the runtime.
- `pi-transport.ts` — the only implementation of that seam against a real pi `AgentSession`. Vendor types stop here.
- `session.ts` — `AgentSession`, the lifecycle orchestrator the engine actually holds: lazy open, turn folding, permission verdicts, compaction, rewind, breakdown files. `rewind` takes a message id and a plain path list; it does not import `engine/boundary`. It takes its transport as an injected factory, so a test drives the exact same object as production.

**The one-shot seam**

- `oneshot.ts` — the vendor-neutral contract: `OneShotFactory` opens an `OneShotSession`, which answers one `send()` and is gone. `access: 'read' | 'write'` is the only knob that matters. Call sites import from here and nowhere else.
- `pi-oneshot.ts` — its implementation: a session with no file behind it (`SessionManager.inMemory`), disposed in a `finally` after every turn.

**Shared by both**

- `model.ts` — resolving a roster model string against what the install can actually reach, plus the thinking-level mapping. A miss is a warning and a fallback, never a failure.
- `vendor-events.ts` — the pi event stream translated into neutral `TransportEvent`s, and per-turn usage summed across the turn's assistant messages.
- `tool-names.ts` — the allowlist strings (`FOUNDRY_TOOL_NAMES`, `BUILTIN_TOOLS`, `READ_ONLY_TOOLS`, `runToolsFor`) with no vendor import, so `session.ts` and `AppContext` can name tools without parsing the runtime.
- `tools.ts` — Foundry's own tools (`report_progress`, `read_phase_context`, `git_diff`, `submit_envelope`, which replaced the MCP server). `git_diff` is the read-only diff affordance: it runs `git diff` against the engine-supplied branch point and nothing else, takes no ref and no argv, and bounds its answer at `GIT_DIFF_MAX_CHARS` with a marker naming the files it dropped.
- `lazy-oneshot.ts` / `lazy-transport.ts` — wrappers that load `pi-oneshot.ts` / `PiTransport` / `SmithPiTransport` on the first turn. `AppContext` and `Executor` construct through these so launch does not parse the vendor package.
- `pi-paths.ts` — `piStateDir()`, used by the Bridge at launch without constructing `ModelRuntime`.
- `policy.ts` — the zero-interrupt write policy: pi tool name → category → allow/deny.
- `policy-extension.ts` — the inline pi extension. `foundryExtension()` registers Foundry's tools, the `tool_call` hook, and `before_agent_start` (the roster role); `policyOnlyExtension()` is the same hook pair with no tools, which is what a one-shot needs.
- `open-session.ts` — shared `createAgentSession` setup (discovery flags, Foundry harness, bind). Both session shapes call it so the flags cannot drift.
- `system-prompt.ts` — the Foundry harness that replaces Pi's default "you are pi" identity. Agent/one-shot standing rules are appended per turn, not stuffed into the user message.
- `transcript.ts` — `foldTranscript`, the shared folder from neutral events to live transcript rows. Detection, setup, and readiness all show the same panel because they all fold the same way.
- `events.ts` — folds the neutral event stream into trace rows, with the throttles and caps that keep a chatty turn from flooding SQLite; writes the raw stream to `<agent>/stream.jsonl`. Runs only; a one-shot has no trace.
- `runtime.ts` — the single memoized `ModelRuntime`, pinned under Foundry's Application Support directory.
- `catalog.ts` — what the runtime can actually reach (`getAvailable()` → `ModelInfo`), plus the credential operations that change that answer. `login(providerId, 'api_key', …)` is the path that **persists** a direct key; `setRuntimeApiKey` only sets an in-memory override that dies with the process.

## Setup Commands

```bash
npm ci
npm run dev   # exercise agent phases through the running app
```

No separate setup: pi is a normal dependency and runs inside the Electron main process.

## Invariants

- **Never touch `~/.pi`.** Pi's defaults read and write the user's own install — auth, model catalog, sessions, skills, extensions. `runtime.ts` pins every path under `<supportDir>/pi/`, `pi-transport.ts` passes `agentDir` explicitly, and sessions go in the run's own trace directory. A default left unpinned silently rewrites a developer's credentials.
- **Discovery is off.** `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`, and `appendSystemPromptOverride: () => []`. What an agent can do comes from the roster and this directory; ancestor `AGENTS.md` / `.pi/SYSTEM.md` must not change what a run does.
- **The roster role is a system prompt.** `systemPromptOverride` installs the Foundry harness (replacing Pi's default persona and doc paths). `before_agent_start` appends the agent's (or one-shot's) standing rules. The user message is the phase ask only — never `system + --- + user`.
- **The tool list is the allowlist.** A tool absent from `createAgentSession({tools})` is absent from the registry, which is why Foundry's four tools are named alongside the seven built-ins.
- **Read-only means no write tool exists.** Detection, setup, and the run-start fill run in the operator's own checkout: no worktree, no boundary diff, nothing that would revert a write. `access: 'read'` gets `READ_ONLY_TOOLS` and the policy's `writes: []` as a second line. A run agent gets the same treatment through `AgentDef.toolProfile: 'read-only'` → `runToolsFor()`, so the roster's read-only agents hold no `edit`, `write`, or `bash` either. Do not implement read-only as a policy that says no to a tool the session still has.
- **Taking a capability away means replacing it, not just removing it.** Dropping `bash` also drops `git diff`, which a reviewer or PR writer needs to do its job at all. `git_diff` exists for that reason: the narrow, engine-scoped affordance stands in for the general one. A read-only profile that leaves an agent unable to see what changed is a broken agent, not a safe one.
- **A one-shot owns its session for exactly one turn.** Dispose in a `finally`, so a failed or cancelled turn releases the model connection too.
- **Agent turns have no Foundry deadline.** They run until they finish, fail at the provider, or the operator explicitly cancels. Do not add a timeout parameter or timer around a model turn.
- **Bind extensions before the first prompt.** Unbound, the foundry extension's tools are registered but its `tool_call` policy is not live — every call would run unruled.
- **Every tool call gets a verdict.** `tool_call` is the enforcement point and the policy always answers. Unknown tools **fail closed**: a pi upgrade that adds a write tool must not get a free pass. (Boundary enforcement itself is still the engine's post-call `git diff`; the policy is the first line, not the guarantee.)
- **Swap the whole envelope tool, between turns only.** pi-ai caches a compiled validator against the schema object's identity, so mutating a live definition keeps the previous phase's validator. `useEnvelopeSchema` keys on the serialized schema and hands over a fresh `ToolDefinition`.
- **Compaction and rewind happen in place.** Pi keeps the same session for both, rather than opening a successor session. There is no id to re-persist and no handle to swap. Rewind branches the session tree **before** the anchor message (the anchor is the phase's own prompt) and restores no files — pi keeps no snapshots, so the worktree half is `engine/rewinder.ts` (`PhaseRewinder` → `boundary.restoreToPhaseStart`).
- **Resolve the worktree cwd fail-closed.** Never fall back to `process.cwd()`; that would point a run's writes at the app checkout.
- **Nothing on this path may need a native binding.** Pi ships prebuilt `.node` files (pi-tui) and a wasm image (an example), but those belong to its interactive terminal UI, and its one optional clipboard binding is loaded behind a try/catch. A binding loaded unguarded at import would fail inside `app.asar`, where a path is not a file, and only in a signed build. `apps/desktop/tests/main/pi/pi-packaging.test.ts` imports the package with `dlopen` blocked to catch that before a DMG does; a future unguarded binding needs an `asarUnpack` entry in `electron-builder.yml`, next to `better-sqlite3`.
- **`PI_OFFLINE=1` is the offline switch.** It is read in `ModelRuntime`'s constructor, so a launch on a captive network builds the runtime off the files already on disk rather than waiting on a catalog fetch. `refreshCatalog` passes `allowNetwork: false` for the same reason.

## Testing Instructions

```bash
npx vitest run apps/desktop/tests/main/pi/pi-policy.test.ts
npx vitest run apps/desktop/tests/main/pi/pi-tools.test.ts
npx vitest run apps/desktop/tests/main/pi/pi-events.test.ts
npx vitest run apps/desktop/tests/main/pi/pi-extension.test.ts
npx vitest run apps/desktop/tests/main/pi/pi-runtime.test.ts
npx vitest run apps/desktop/tests/main/pi/pi-catalog.test.ts
npx vitest run apps/desktop/tests/main/pi/pi-transport.test.ts
npx vitest run apps/desktop/tests/main/pi/pi-oneshot.test.ts
npx vitest run apps/desktop/tests/main/pi/pi-packaging.test.ts
npx vitest run apps/desktop/tests/main/pi/pi-transcript.test.ts
npx vitest run apps/desktop/tests/main/engine/prompts.test.ts
npx vitest run apps/desktop/tests/main/pi/agent-session-transport.test.ts
npx vitest run apps/desktop/tests/main/engine/rewinder.test.ts
npx vitest run apps/desktop/tests/main/engine/executor.test.ts
```

- `apps/desktop/tests/helpers/scripted-transport.ts` implements `AgentTransport` directly and `apps/desktop/tests/helpers/scripted-oneshot.ts` implements `OneShotFactory`; neither imports a vendor package. Engine, session, detection, repair, and readiness suites drive them, so they test Foundry's behaviour rather than pi's.
- `apps/desktop/tests/main/pi/pi-transport.test.ts` and `apps/desktop/tests/main/pi/pi-oneshot.test.ts` are the exceptions: they replace the vendor module with a scripted session, because a real one needs a provider, a credential, and a network. They cover what Foundry **states** when it opens a session (paths, discovery flags, tool list, settings) and how a turn is read back out.
- `apps/desktop/tests/main/pi/pi-runtime.test.ts` builds a **real** `ModelRuntime` into a temp directory and asserts `~/.pi` is untouched before and after. Keep that assertion.
- Policy, tools, and event folding are pure enough to test directly; do not reach for a session to test them.

## Code Style

- `@earendil-works/pi-*` imports live in this directory only (ESLint `no-restricted-imports`); `pi-transport.ts` and `pi-oneshot.ts` are where they concentrate. `transport.ts`, `oneshot.ts`, `session.ts`, `policy.ts`, `transcript.ts`, `events.ts`, `tool-names.ts`, `lazy-oneshot.ts`, `lazy-transport.ts`, and `pi-paths.ts` are deliberately vendor-free.
- Pi's transitive packages (`pi-agent-core`, `pi-ai`) are **not** Foundry dependencies. Derive the types you need from `pi-coding-agent`'s own surface rather than importing them.
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
```

`@earendil-works/pi-coding-agent` is exact-pinned and stays **external**: `externalizeDepsPlugin()` leaves every `dependencies` entry as a runtime require, so electron-builder ships pi as real files rather than inlining a package that resolves its own files by path.

## Additional Notes

- Pinned official docs for this layer: `references/` at the repo root. Recopy from `node_modules/@earendil-works/pi-coding-agent/docs/` when the package pin bumps.
- `session.ts` writes a per-agent context breakdown file next to the stream; the renderer reads it for the context gauge.
- Model and thinking level start from the roster. After five exhausted transient-error retries, the session cycles through the reachable model catalog without resetting its conversation, **skipping `hiddenModelIds`**. The current model may itself be hidden (the operator or roster named it); failover will not spend a retry budget on anything else the operator hid. `applySettings()` reports that live model rather than reverting the failover between phases.
- A model the install cannot reach is a **warning plus a fallback**, not a failed run: the trace records what actually ran.
- A one-shot's caller never believes the agent's own account of what it did. `engine/repair.ts` re-derives its verdict from git; detection verifies each proposed command by running it. The turn produces a claim, not a result.
- Cancelling a one-shot is `abort()`, and an abort landing before the session finishes opening skips the turn entirely — that window between the click and the first token is where a cancel most often lands.
