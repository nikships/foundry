# AGENTS.md — src/main/pi

The transport agent phases run on. Pi runs **in this process**: no daemon, no child process, no wire protocol, no MCP server. This directory is the only place in the app allowed to name `@earendil-works/pi-*`.

## Project Overview

- `transport.ts` — the vendor-neutral seam. `AgentTransport` plus the neutral event, usage, permission, and rewind types. **Everything above this directory imports from here and nowhere else**, which is what lets the engine and the test fixtures stay ignorant of the runtime.
- `pi-transport.ts` — the only implementation of that seam against a real pi `AgentSession`. Vendor types stop here.
- `session.ts` — `AgentSession`, the lifecycle orchestrator the engine actually holds: lazy open, turn folding, permission verdicts, compaction, rewind, breakdown files. It takes its transport as an injected factory, so a test drives the exact same object as production.
- `policy.ts` — the zero-interrupt write policy: pi tool name → category → allow/deny.
- `policy-extension.ts` — the inline pi extension: registers Foundry's tools and installs the `tool_call` hook that applies `policy.ts`.
- `tools.ts` — `report_progress`, `read_phase_context`, `submit_envelope`. These replaced Foundry's MCP server; they are ordinary in-process tools now.
- `events.ts` — folds the neutral event stream into trace rows, with the throttles and caps that keep a chatty turn from flooding SQLite; writes the raw stream to `<agent>/stream.jsonl`.
- `runtime.ts` — the single memoized `ModelRuntime`, pinned under Foundry's Application Support directory.

## Setup Commands

```bash
npm ci
npm run dev   # exercise agent phases through the running app
```

No separate setup: pi is a normal dependency and runs inside the Electron main process.

## Invariants

- **Never touch `~/.pi`.** Pi's defaults read and write the user's own install — auth, model catalog, sessions, skills, extensions. `runtime.ts` pins every path under `<supportDir>/pi/`, `pi-transport.ts` passes `agentDir` explicitly, and sessions go in the run's own trace directory. A default left unpinned silently rewrites a developer's credentials.
- **Discovery is off.** `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`. What an agent can do comes from the roster and this directory; whatever the operator installed for their own pi must not change what a run does.
- **The tool list is the allowlist.** A tool absent from `createAgentSession({tools})` is absent from the registry, which is why Foundry's three tools are named alongside the seven built-ins.
- **Bind extensions before the first prompt.** Unbound, the foundry extension's tools are registered but its `tool_call` policy is not live — every call would run unruled.
- **Every tool call gets a verdict.** `tool_call` is the enforcement point and the policy always answers. Unknown tools **fail closed**: a pi upgrade that adds a write tool must not get a free pass. (Boundary enforcement itself is still the engine's post-call `git diff`; the policy is the first line, not the guarantee.)
- **Swap the whole envelope tool, between turns only.** pi-ai caches a compiled validator against the schema object's identity, so mutating a live definition keeps the previous phase's validator. `useEnvelopeSchema` keys on the serialized schema and hands over a fresh `ToolDefinition`.
- **Compaction and rewind happen in place.** Pi keeps the same session for both, unlike the daemon's successor sessions. There is no id to re-persist and no handle to swap. Rewind branches the session tree **before** the anchor message (the anchor is the phase's own prompt) and restores no files — pi keeps no snapshots, so the worktree half is `engine/boundary.ts:restoreToPhaseStart`.
- **Resolve the worktree cwd fail-closed.** Never fall back to `process.cwd()`; that would point a run's writes at the app checkout.

## Testing Instructions

```bash
npx vitest run tests/pi-policy.test.ts
npx vitest run tests/pi-tools.test.ts
npx vitest run tests/pi-events.test.ts
npx vitest run tests/pi-extension.test.ts
npx vitest run tests/pi-runtime.test.ts
npx vitest run tests/pi-transport.test.ts
npx vitest run tests/agent-session-transport.test.ts
npx vitest run tests/executor.test.ts
```

- `tests/scripted-transport.ts` implements `AgentTransport` directly and imports no vendor package. Engine and session suites drive it, so they test Foundry's behaviour rather than pi's.
- `tests/pi-transport.test.ts` is the exception: it replaces the vendor module with a scripted session, because a real one needs a provider, a credential, and a network. It covers what Foundry **states** when it opens a session (paths, discovery flags, tool list, settings) and how a turn is read back out.
- `tests/pi-runtime.test.ts` builds a **real** `ModelRuntime` into a temp directory and asserts `~/.pi` is untouched before and after. Keep that assertion.
- Policy, tools, and event folding are pure enough to test directly; do not reach for a session to test them.

## Code Style

- `@earendil-works/pi-*` imports live in this directory only (ESLint `no-restricted-imports`); `pi-transport.ts` is where they concentrate. `transport.ts`, `session.ts`, `policy.ts`, and `events.ts` are deliberately vendor-free.
- Pi's transitive packages (`pi-agent-core`, `pi-ai`) are **not** Foundry dependencies. Derive the types you need from `pi-coding-agent`'s own surface rather than importing them.
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
```

`@earendil-works/pi-coding-agent` is exact-pinned. It bundles into `out/main/main.js` like the rest of main.

## Additional Notes

- `session.ts` writes a per-agent context breakdown file next to the stream; the renderer reads it for the context gauge.
- Model and thinking level are stated once at create and never drift, so `applySettings()` has nothing to re-assert and simply reports the active model.
- A model the install cannot reach is a **warning plus a fallback**, not a failed run: the trace records what actually ran.
