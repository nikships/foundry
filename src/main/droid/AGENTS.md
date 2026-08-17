# AGENTS.md — src/main/droid

Owns the shared one-shot Droid runner, the model catalog, permissions, and the SDK adapter. **Agent phases no longer run here** — they run in-process on the agent transport in `src/main/pi/`.

## Project Overview

- `oneshot.ts` (`droid exec`) is what this directory is still for: detection (`engine/detect-session.ts`), project setup (`engine/setup-session.ts`), readiness repair (`readiness/remediator.ts`, `engine/repair.ts`), and the summariser in `ipc/runs.ts`. Those are one-off text calls with no write boundary to enforce.
- **The daemon (`sdk/daemon.ts` + `sdk/daemon-session.ts`, `127.0.0.1:37600–37699`, `--parent-pid`) no longer carries any agent phase.** It is still built and still shut down with the app; the call sites above are what remain to migrate, and until they are gone this code stays.
- SDK boundary: all production `@factory/droid-sdk` imports live under `sdk/` (ESLint `no-restricted-imports`). Above it, code uses `TransportSession` + `turn.ts` + `protocol.ts` types. A second, independent boundary keeps `@earendil-works/pi-*` inside `src/main/pi/`.
- Notifications → trace events (`events.ts`); permissions → approval `ask_user` flow (`permissions.ts`); catalog/model discovery → `catalog.ts`, which the agent transport also reports into.

## Why there is no fallback

Foundry used to degrade daemon → subprocess → one-shot whenever the daemon could not do something. Only the daemon and subprocess transports route tool calls through `permissions.ts`; **one-shot does not consult it at all**. A run that slid to one-shot silently traded Foundry's write-boundary policy for the CLI's coarser `--auto` gate, and the operator was told nothing. The observed failure was worse than theoretical: an unrelated per-agent setting pushed every run onto that path, and a run then died with `insufficient permission to proceed` from a layer that has no permission model.

The same rule holds now that agent phases have moved: the transport in `pi/` either runs the turn or the turn fails. Nothing falls back to `oneshot.ts`, because it has no policy seam to fall back to.

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

- **Daemon** starts lazily as `droid daemon --port <p> --host 127.0.0.1 --parent-pid <app>`, scanning up within `37600–37699`. Auth reads Settings `factoryApiKey`, then `FACTORY_API_KEY`, then a stored WorkOS JWT, without logging. `ensure()` returns a failure reason rather than throwing. One traced `processes` row for the daemon, not per-session; a daemon session has no child pid (`kill` interrupts/closes it).
- **Compaction/rewind on a daemon session** return successor sessions: swap the handle, re-subscribe notifications, and re-apply settings after the successor loads. The SDK rejects replacement while a stream is open, so both only happen between turns. (The agent transport in `pi/` compacts and rewinds **in place** — do not carry the successor-swap assumption across.)

## Testing Instructions

```bash
npm test
npx vitest run -t "sdk|daemon|droid|permission|mcp"
npx vitest run tests/sdk-daemon-session.test.ts
npx vitest run tests/sdk-daemon-manager.test.ts
```

- `tests/scripted-daemon.ts` — a scripted `DaemonSessionsFacade` for `DaemonSession` unit tests.
- The fixture is in-memory: no daemon, no API key, no model, no child process. Agent-phase behaviour is exercised through `tests/scripted-transport.ts` against `src/main/pi/`.
- **Stub frames must be schema-complete** (`createdAt`, `updatedAt`, `tokenUsage`, valid tool categories, matching turn IDs) or the SDK silently drops them and the turn hangs.
- Keep `oneshot.ts` vendor-agnostic; put flags in `src/main/cli/droid.ts`.

## SDK and Daemon Boundaries

- `protocol.ts` is types/constants, not a hand-rolled JSON-RPC client.
- Auth never writes or logs the secret.
- The trace, the run row, and the renderer all record which mode a run used. New agent runs record `'pi'`; historical rows still carry `'daemon'` / `'rpc'` / `'oneshot'`, which is why `RunMode` keeps every member. **Never narrow that union** — it would make old runs unreadable.

## Protocol and Policy Landmines

- Frames require the factory `type`/`version` fields and string `requestId`s.
- `add_user_message` uses `params.text`; completion must echo the SDK-minted turn id.
- Session settings are flat params; autonomy is stated on every `create`/`resume`.
- A bad model is accepted at `settings` time and fails on the turn. Structured-output failure still returns text for caller validation. Droid compiles Draft-07 — do not add a `2020-12` `$schema`.
- **Zero-interrupt policy** always returns a decision: in-boundary writes/commands → allow; out-of-worktree or protected writes → deny. `ask_user` is answered with each question's first option (`proceed_once` or cancel). A missing answer is interpreted as cancellation. `pi/policy.ts` restates the same rule for the agent transport; the two are separate implementations because the tool vocabularies differ.

## Code Style

- Only `sdk/**` imports `@factory/droid-sdk`; everything above uses `TransportSession`. Do not import `@earendil-works/pi-*` here — that seam is `src/main/pi/`.
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
