# src/main/droid

This directory owns Droid transport selection, the shared one-shot runner,
permissions, and the SDK adapter. `agent.ts` selects daemon by default,
subprocess RPC when requested or when daemon setup fails, and one-shot after
two protocol strikes. A strike is counted once for the failing turn; a kill is
not a strike and must stop all recovery.

## SDK and daemon boundaries

All production `@factory/droid-sdk` imports stay under `sdk/` (SDK tests are
the exception). Above that boundary, use `TransportSession` and `turn.ts`.
`protocol.ts` is types/constants, not a hand-rolled JSON-RPC client.

The daemon starts lazily as `droid daemon --port <p> --host 127.0.0.1
--parent-pid <app>`, using the configured port and scanning upward only within
37600–37699. Auth reads `FACTORY_API_KEY` or the stored WorkOS JWT without
writing or logging the secret. `ensure()` returns a failure reason for
fallback instead of throwing. The daemon is one traced process, not one row
per session; a daemon session has no child pid (`kill` interrupts/closes it).
A roster with a tool allowlist cannot use daemon because its high-level API
cannot list tools, so it fails closed to subprocess.

Compaction/rewind return successor sessions: swap the handle, re-subscribe
notifications, and re-apply settings after the successor loads. The SDK
rejects replacement while a stream is open. The sniffing transport preserves
init-time models and early notifications and injects context breakdown,
which is why code must not use the SDK's private client.

## Protocol and policy landmines

Frames require the factory type/version fields and string request IDs.
`add_user_message` uses `params.text`; completion must echo the SDK-minted
turn id. Session settings are flat params, autonomy is stated on every
create/resume, and `--auto` is cosmetic for JSON-RPC. A bad model is accepted
at settings time and fails on the turn, while structured-output failure still
returns text for caller validation. Droid compiles output schemas as Draft-07;
do not add a 2020-12 `$schema` URI.

Tool allowlists are a complement implemented through `disabledToolIds`, then
verified with `listTools()`. `ToolSearch` remains available; Foundry's two MCP
tools are always allowed. Attachments can lag `mcp_status_changed`, so tool
recomputation is scheduled rather than immediate. Foundry MCP tools use the
SDK's nested zod 3 and are attached at session create/resume, never by writing
`~/.factory/mcp.json`.

The zero-interrupt policy always returns a decision: in-boundary writes and
commands allow, out-of-worktree or protected writes deny, and `ask_user` is
answered with each question's first option. Answers belong on the decision;
a missing answer is interpreted as cancellation. Permission handlers adapt
flat Foundry decisions to SDK selections (`proceed_once` or cancel).

## Tests

`tests/fake-droid.ts` is the real-child handshake fixture; executor tests use
a separate scripted child for disk side effects; the in-memory transport
covers session logic. Stub frames must be schema-complete (`createdAt`,
`updatedAt`, `tokenUsage`, valid tool categories, and matching turn IDs), or
the SDK silently drops them and the turn hangs. Keep `oneshot.ts`
vendor-agnostic and put flags in `cli/`.
