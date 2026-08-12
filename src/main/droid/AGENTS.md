# AGENTS.md — src/main/droid

Owns Droid transport selection, the shared one-shot runner, permissions, and the SDK adapter. `agent.ts` selects **daemon** by default, **subprocess RPC** when requested or when daemon setup fails, and **one-shot** after two protocol strikes.

## Project Overview

- Transports: daemon (`SdkDaemonManager` + `SdkDaemonSession`, `127.0.0.1:37600–37699`, `--parent-pid`), subprocess RPC (`SdkSession` via `ProcessTransport`), one-shot (`oneshot.ts` → `droid exec`).
- SDK boundary: all production `@factory/droid-sdk` imports live under `sdk/` (ESLint `no-restricted-imports`). Above it, code uses `TransportSession` + `turn.ts` + `protocol.ts` types.
- Notifications → trace events (`events.ts`); permissions → approval `ask_user` flow (`permissions.ts`); catalog/model discovery → `catalog.ts`.
- `PROTOCOL_FAILURE_LIMIT = 2` — a strike is counted once for the failing turn; a kill is not a strike and must stop all recovery.

## Setup Commands

```bash
npm ci
# Requires `droid` CLI on PATH and signed in (FACTORY_API_KEY or stored WorkOS JWT).
droid --version
npm run dev    # exercise transports through the running app
```

`resolveEnv()` must complete before any `droid` spawn; every spawn uses `spawnEnv()`.

## Development Workflow

- **Daemon** starts lazily as `droid daemon --port <p> --host 127.0.0.1 --parent-pid <app>`, scanning up within `37600–37699`. Auth reads `FACTORY_API_KEY` or stored WorkOS JWT without logging. `ensure()` returns a failure reason for fallback rather than throwing. One traced `processes` row for the daemon, not per-session; a daemon session has no child pid (`kill` interrupts/closes it). A roster with a tool allowlist cannot use daemon (its high-level API cannot list tools) — falls back to subprocess.
- **Compaction/rewind** return successor sessions: swap the handle, re-subscribe notifications, and re-apply settings after successor loads. SDK rejects replacement while a stream is open.
- **Sniffing transport** preserves init-time models and early notifications and injects context-breakdown; do not reach into the SDK's private client.

## Testing Instructions

```bash
npm test
npx vitest run -t "sdk|daemon|droid|permission|mcp"
npx vitest run tests/sdk-daemon-session.test.ts
npx vitest run tests/sdk-daemon-manager.test.ts
npx vitest run tests/agent-session-transport.test.ts
```

- `tests/fake-droid.ts` — real child handshake fixture (exercise protocol framing realistically).
- Executor tests use a separate scripted child for disk side effects; in-memory transport covers session logic.
- **Stub frames must be schema-complete** (`createdAt`, `updatedAt`, `tokenUsage`, valid tool categories, matching turn IDs) or the SDK silently drops them and the turn hangs.
- Keep `oneshot.ts` vendor-agnostic; put flags in `src/main/cli/droid.ts`.

## SDK and Daemon Boundaries

- `protocol.ts` is types/constants, not a hand-rolled JSON-RPC client.
- Auth never writes or logs the secret; daemon fallback traces `log` with `fallback to subprocess: <reason>` (warning span).
- Tool allowlists are a complement via `disabledToolIds`, verified by `listTools()`. `ToolSearch` remains available; Foundry's two MCP tools are always allowed.
- **Host invocables are opt-in per agent.** `invocables.ts` reads `~/.factory` (skills, custom Droids, `mcp.json`) as a read-only inventory; `AgentDef.invocables` is an allowlist of ids that defaults to empty, so an agent inherits nothing from the operator's install. Skills are withheld with the settings complement; Droids and host MCP servers are withheld by spawning against a `FactoryHomeOverlay` (`factory-home.ts`) — a temp `$HOME` of symlinks whose `.factory` keeps auth/settings/sessions but carries only the selected `droids/` and a rewritten `mcp.json`. Nothing writes the host install. The daemon fails closed (shared process, one env) for any agent that needs either mechanism, exactly as it does for `restrictTools`. Attachments can lag `mcp_status_changed`, so recomputation is scheduled, not immediate. Foundry MCP tools use the SDK's nested `zod@3` and are attached at session create/resume — never by writing `~/.factory/mcp.json`.

## Protocol and Policy Landmines

- Frames require the factory `type`/`version` fields and string `requestId`s.
- `add_user_message` uses `params.text`; completion must echo the SDK-minted turn id.
- Session settings are flat params; autonomy is stated on every `create`/`resume`; `--auto` is cosmetic for JSON-RPC.
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
