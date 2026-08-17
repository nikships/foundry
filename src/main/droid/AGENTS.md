# AGENTS.md — src/main/droid

Owns the Droid transport, the shared one-shot runner, permissions, and the SDK adapter. **Agent phases run on the daemon and nowhere else.**

## Project Overview

- **One agent transport: the daemon.** `agent.ts` opens a daemon session (`sdk/daemon.ts` + `sdk/daemon-session.ts`, `127.0.0.1:37600–37699`, `--parent-pid`). If it cannot be reached, or a turn fails on it, the turn fails. There is no fallback ladder.
- `oneshot.ts` (`droid exec`) is still used, but never for an agent phase: detection (`engine/detect-session.ts`), project setup (`engine/setup-session.ts`), readiness repair (`readiness/remediator.ts`, `engine/repair.ts`), and the summariser in `ipc/runs.ts`. Those are one-off text calls with no write boundary to enforce.
- SDK boundary: all production `@factory/droid-sdk` imports live under `sdk/` (ESLint `no-restricted-imports`). Above it, code uses `TransportSession` + `turn.ts` + `protocol.ts` types.
- Notifications → trace events (`events.ts`); permissions → approval `ask_user` flow (`permissions.ts`); catalog/model discovery → `catalog.ts`.

## Why there is no fallback

Foundry used to degrade daemon → subprocess → one-shot whenever the daemon could not do something. Only the daemon and subprocess transports route tool calls through `permissions.ts`; **one-shot does not consult it at all**. A run that slid to one-shot silently traded Foundry's write-boundary policy for the CLI's coarser `--auto` gate, and the operator was told nothing. The observed failure was worse than theoretical: an unrelated per-agent setting pushed every run onto that path, and a run then died with `insufficient permission to proceed` from a layer that has no permission model.

The features that could not be enforced on the daemon were deleted rather than kept as fallback triggers:

- **Tool profiles / allowlists / phase narrowing** (`tool-profiles.ts`, `AgentDef.tools`, `PhaseDef.toolProfile`). The daemon's `droid.mcp.listTools` returns MCP tools only, never builtins, so a profile could not be computed, let alone verified.
- **Host invocable selection** (`invocables.ts`, `factory-home.ts`). Withholding host skills / Droids / MCP servers needed a per-agent `$HOME` overlay. The daemon is one shared process with one environment, so it can never have one.
- **The `transport` setting.** A user-facing toggle whose only effect was to leave the daemon.

Foundry's own MCP servers (`userMcpServers`) survive all of this: they are attached in-process at session create/resume, never by writing `~/.factory/mcp.json`, so they cost no transport.

## Setup Commands

```bash
npm ci
# Requires `droid` CLI on PATH and a Factory credential (Settings API key, FACTORY_API_KEY, or stored WorkOS JWT).
droid --version
npm run dev    # exercise the transport through the running app
```

`resolveEnv()` must complete before any `droid` spawn; every spawn uses `spawnEnv()`.

## Development Workflow

- **Daemon** starts lazily as `droid daemon --port <p> --host 127.0.0.1 --parent-pid <app>`, scanning up within `37600–37699`. Auth reads airgap first, then Settings `factoryApiKey`, then `FACTORY_API_KEY`, then a stored WorkOS JWT, without logging. `ensure()` returns a failure reason rather than throwing, and `agent.ts` turns that reason into a failed turn. One traced `processes` row for the daemon, not per-session; a daemon session has no child pid (`kill` interrupts/closes it).
- **Airgap mode** (`airgap.ts`, Settings → Agent CLI) runs droid with `FACTORY_AIRGAP_ENABLED=1`. The CLI then short-circuits every auth path to a synthetic identity, reads no keyring or `~/.factory/auth.v2.*`, and throws on any request aimed at a Factory endpoint. Three layers read the one flag: `sdk/auth.ts` returns the `airgapped-token` placeholder (the daemon accepts any non-empty string but rejects an empty one), `catalog.ts` narrows the picker to BYOK `customModels`, and `system/doctor.ts` checks for a custom model instead of a credential. A stored Factory key is withheld from child environments while the mode is on. Verified against CLI 0.197.0.
- **Compaction/rewind** return successor sessions: swap the handle, re-subscribe notifications, and re-apply settings after the successor loads. The SDK rejects replacement while a stream is open, so both only happen between turns.

## Testing Instructions

```bash
npm test
npx vitest run -t "sdk|daemon|droid|permission|mcp"
npx vitest run tests/sdk-daemon-session.test.ts
npx vitest run tests/sdk-daemon-manager.test.ts
npx vitest run tests/agent-session-transport.test.ts
```

- `tests/scripted-daemon.ts` — a scripted `DaemonSessionsFacade` for `DaemonSession` unit tests.
- `tests/scripted-agent.ts` — `ScriptedAgent`, the in-memory daemon the executor tests run against. It performs the turn's disk side effects inside the worktree and answers asks through the real permission handlers, so boundary and policy assertions are real.
- Both fixtures are in-memory: no daemon, no API key, no model, no child process.
- **Stub frames must be schema-complete** (`createdAt`, `updatedAt`, `tokenUsage`, valid tool categories, matching turn IDs) or the SDK silently drops them and the turn hangs.
- Keep `oneshot.ts` vendor-agnostic; put flags in `src/main/cli/droid.ts`.

## SDK and Daemon Boundaries

- `protocol.ts` is types/constants, not a hand-rolled JSON-RPC client.
- Auth never writes or logs the secret.
- `AgentSession.Mode` is a deliberate one-member union (`'daemon'`). The trace, the run row, and the renderer all record which mode a run used; keeping the field makes the guarantee legible instead of implicit. Trace rows written before this change still carry `'rpc'` / `'oneshot'`, which is why the `RunRow` / `AgentSessionRow` types keep those members.

## Protocol and Policy Landmines

- Frames require the factory `type`/`version` fields and string `requestId`s.
- `add_user_message` uses `params.text`; completion must echo the SDK-minted turn id.
- Session settings are flat params; autonomy is stated on every `create`/`resume`.
- A bad model is accepted at `settings` time and fails on the turn. Structured-output failure still returns text for caller validation. Droid compiles Draft-07 — do not add a `2020-12` `$schema`.
- **Zero-interrupt policy** always returns a decision: in-boundary writes/commands → allow; out-of-worktree or protected writes → deny. `ask_user` is answered with each question's first option (`proceed_once` or cancel). A missing answer is interpreted as cancellation.

## Code Style

- Only `sdk/**` imports `@factory/droid-sdk`; everything above uses `TransportSession`.
- Keep argv/parse in `cli/`, wire framing in `sdk/`, policy in `permissions.ts`.
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
```

Transport code is bundled into `out/main/main.js`; `@factory/droid-sdk` is externalized as `require`.

## Additional Notes

- `turn.ts` is the narrow turn helper consumed by the engine; notification shapes follow the Droid protocol types.
- `catalog.ts` / `oneshot.ts` share parsing conventions with `cli/droid.ts`.
