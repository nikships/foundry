# AGENTS.md — src/main/droid

Droid's transports + shared one-shot runner. `agent.ts` drives `sdk/session.ts`
for RPC turns and falls back to `oneshot.ts`; `protocol.ts` encodes findings
observed against the real CLI, not the docs. `turn.ts` holds the shapes both
transports agree on (`TurnResult`, `PermissionAsk`, `PermissionDecision`,
`INHERIT_MODEL`) so nothing above the seam has to know which one ran.

`AgentSession` degrades after two transport failures in a run. Strikes are
counted on the failing turn only: a dying child both rejects its in-flight turn
and fires an exit callback, so counting in both places would spend the whole
budget on one death.

**A kill is not a strike.** `kill()` latches, and every recovery path stands
down once it has: the rejected turn is not counted, not restarted, and not
answered one-shot — it raises the kill instead, and the executor settles the
run `killed`. Without that latch a killed child looks exactly like a flapping
one, and the two-strike fallback finishes the phase and settles the run
`accepted` after the operator ended it. The latch is also checked _after_ a
session handshake completes: a `kill()` that ran while a restart was still
starting up never saw that child, so it closes itself instead of taking a turn.

Every one-shot turn spawns its own child and gets its own `processes` row
(opened at spawn, closed on exit). A fallback child with no row is invisible to
the kill path and to the relaunch sweep.

## Invariants

- **All SDK imports live in `src/main/droid/sdk/`.** ESLint enforces it
  (`tests/sdk-*.test.ts` are the one other exception). Everything above the
  seam talks to `SdkSession` and to `turn.ts`, never to `@factory/droid-sdk`.
- There is no hand-rolled JSON-RPC framing left. `SdkSession` owns the wire for
  RPC turns; `protocol.ts` is now types + constants only (notification shapes,
  `AUTONOMY_LEVEL`, `request`/`response` builders the stubs and `oneshot.ts`
  side still describe), not a client.

## Three quirks a naive client gets wrong

The SDK handles all three now. They are kept here because the stubs in `tests/`
have to reproduce them, and because `oneshot.ts` still talks to the CLI without
the SDK in front of it.

1. Every frame needs `type` + `factoryApiVersion`/`factoryProtocolVersion` —
   plain JSON-RPC is rejected `-32700`.
2. Request `id` must be a string — numeric is rejected the same way.
3. Session settings (`modelId`, reasoning effort, autonomy) are **flat params**
   on `droid.update_session_settings` — nested under `settings` they are
   silently ignored.

Also: `add_user_message` takes `params.text` (not `message`) and returns
immediately; turn ends with `agent_turn_completed`. `tool_call` is re-emitted
per `toolUseId` — fold into one span. `droid.ask_user` wants one free-text
answer per question (`{answers:[{index,question,answer}]}`), never a yes/no —
a verdict reads as a cancellation and the agent asks again. `oneshot.ts` must
stay vendor-agnostic; vendor flags belong in `cli/<vendor>.ts`.

## Testing against a stub CLI

Two stubs answer the SDK's handshake over a real child: `tests/fake-droid.ts`
(driven by `tests/sdk-session-child.test.ts`, the only suite that exercises
`spawnTransport()` — pid, stderr pipe, exit code), and the inline
`scriptedDroid` in `tests/executor.test.ts` (a separate one because the
executor's stub scripts whole turns, including side effects on disk). The
scripted in-memory transport in `tests/sdk-session.test.ts` covers everything
that does not need a process.

The SDK validates every frame with the CLI's own zod schemas and drops what
fails, so a stub must be schema-complete rather than merely plausible — a
`create_message` without `createdAt`/`updatedAt`, a completion without
`tokenUsage`, or a tool with `category:'exec'` instead of `'execute'` is
discarded in silence and the turn hangs instead of failing. The sharpest edge
is the turn id: the SDK mints it, sends it as `add_user_message.messageId`, and
requires `agent_turn_completed` to echo it. Omitting it raises a protocol
error; a _mismatched_ one is ignored, so the turn hangs to its timeout.

A stub must also fail a forbidden model the way the CLI does — as an `error`
notification during the turn, never as an error response to
`update_session_settings`, which the CLI always accepts (see below).

## The SDK seam (`sdk/`)

`sdk/` is the only place `@factory/droid-sdk` may be imported (ESLint enforces
it; tests/sdk-\*.test.ts are the one other exception). Everything else talks to
`SdkSession`, so the transport stays swappable. `sdk/errors.ts` exists for that
reason: it owns `DroidProtocolError` (what this seam raises: a timed-out turn,
an error result, a session used before it started) and classifies the SDK's own
four transport errors for `agent.ts`, which may not name them itself.

### DaemonManager (`sdk/daemon.ts` + `sdk/auth.ts`)

One local `droid daemon` for the app process, started lazily on first
`ensure()` — never at boot. Spawn argv is
`droid daemon --port <p> --host 127.0.0.1 --parent-pid <app>` so an unclean
quit still reaps the child. Port comes from `AppSettings.daemonPort` (default
37643); a busy preferred port scans **up** inside 37600–37699 only. Auth is
`resolveDaemonAuth()`: `FACTORY_API_KEY` if set, else the stored WorkOS JWT
decrypted read-only from `~/.factory/auth.v2.{file,key}` (AES-256-GCM
`iv:tag:ciphertext`). Never write `~/.factory`, never log the secret.

`ensure()` never throws: spawn/connect/auth failure returns
`{ok:false, reason}` (`auth_missing` | `auth_rejected` | `spawn_failed` |
`connect_failed` | `port_exhausted` | `health_timeout`) so callers fall back
to subprocess. The connect path is injectable (`opts.connect`) for vitest.
`onProcess` fires once with `{pid, port, command}` — wire it to
`tracer.recordProcess({ kind:'droid', name:'daemon', ... })` (one row for the
daemon, not per session). `shutdown()` is disconnect + SIGTERM; app quit calls
it from `AppContext.dispose` (and `--parent-pid` is the crash backstop).

Daemon `sessions.create` requires `machineId` (pass `'default'`) — that lands
with the DaemonSession wrapper, not this manager.

Three things the SDK cannot give us, all solved by the one decorator in
`sdk/sniffing-transport.ts`:

- `availableModels` lives only on the `initialize_session` response envelope,
  which `createSession()` discards.
- ~5 notifications fire before `createSession()` resolves, which is the
  earliest anything can subscribe — without the tap, stream.jsonl starts
  mid-conversation.
- `droid.get_context_breakdown` is a real method with no `DroidSession`
  counterpart; the decorator injects the request and swallows the response so
  the SDK's client never sees an id it did not issue. Never reach for the
  session's private `_client`.

A breakdown can only be read off a live session, and the Inspector is mostly
read after the fact, so `agent.ts` writes the last one each turn produced to
`{agent}/context-breakdown.json` among the run's files. The registry prefers a
live read and falls back to that snapshot; without it a finished run answers
every operator the same way, with an empty panel.

### Compaction and rewind retire the handle they were called on

`compact()` / `rewind()` do not mutate a session in place — each returns a
**new** `DroidSession` and retires the old one (any later frame on it raises
`SessionReplacedError`), so `SdkSession.compact()` / `rewind()` swap the
handle, follow `id` to the successor, and re-subscribe: the SDK releases the
retired handle's notification callbacks as the successor loads, so a missed
re-subscribe leaves the trace silent for the rest of the run. The replacement
is a `load_session`, which carries no settings, so `applySettings()` runs again
for the same reason a resume re-states them. The SDK also refuses a replacement
while a stream is open, which is why the engine only compacts between phases
and only rewinds between correction turns.

`SdkSession` tracks `lastUserMessageId` from user-role `create_message`
notifications so the engine can name the phase-start rewind anchor.
`AgentSession.rewind({messageId, snapshot})` intersects `getRewindInfo`'s
`availableFiles` with the phase-start snapshot (CLI hashes go on the wire),
deletes `createdFiles`, swap-and-persists like compaction, and returns null on
any failure so the runner can fall back to append-style correction. One-shot
`canRewind` is always false.

Two more SDK behaviours the code works around: `--auto` is inert for a
stream-jsonrpc session, and the SDK's stderr goes through a logger that strips
message text from any customer sink — so `sdk/session.ts` reads
`childProcess.stderr` directly.

The autonomy finding is worth stating precisely, because the pre-SDK client
claimed the opposite in a comment. `--auto` on the argv **does not bound a
JSON-RPC session at all**: it is validated at spawn and then ignored, and the
session-level `autonomyLevel` moves freely in both directions past it. The
session setting is the only bound, and omitting it defaults to `high` — so
`autonomyLevel` is stated explicitly on every create and re-stated after every
resume (`load_session` carries no settings). `--auto` is still passed so `ps`
describes the child the way the session is actually configured.

### Settings the CLI accepts and then ignores

`createSession` carries autonomy and cwd only. The model and reasoning effort
travel in the `update_session_settings` that follows, because both need droid's
own `availableModels` (which arrives on that same init response) — the effort
to gate against `supportedReasoningEfforts`, the model to know the default to
fall back to. An unsupported effort is dropped rather than sent: a rejected
setting would fail the whole session for a preference.

A modelId droid does not know, or the org forbids, is **accepted silently** at
init and at `update_session_settings`, and `settings.modelId` echoes it back.
It only fails when a turn runs on it, as a non-throwing terminal result
(`success:false`, `subtype:'error_during_execution'`, empty `text`, a 400
"Invalid model ID" in `result.error.message`). So substitution is a turn-time
retry — re-state the default model, run the turn again once, report which model
won — and the free pre-turn check against `availableModels` still runs first.

### A schema droid could not honour is a completed turn

`subtype:'error_structured_output'` (turn reasons `structured_output_missing` /
`_invalid` / `_schema_invalid`) is the one `success:false` result `runTurn` does
**not** throw on. The turn ran and `text` still holds the answer, so refusing it
here would deny the engine the fallback it is built to take. `structuredOutput`
is returned as a plain object or `null`, never a verdict — the caller validates.

Note `_schema_invalid` blames the _request_: droid compiles the requested schema
with a Draft-07 ajv, so a schema declaring the 2020-12 dialect fails every turn.

### The allowlist is a complement

`restrictToolIds` is stripped by the SDK's public schemas; only the subtractive
`disabledToolIds` survives. An allowlist therefore becomes "disable everything
else", merged with any explicitly disabled tools. Three things this depends on:

- `updateSettings` accepts tool ids that do not exist without any error, so the
  only proof of what applied is a `listTools()` re-read (`ToolInfo.id` is the
  llmId the roster names).
- `ToolSearch` ignores `disabledToolIds` entirely. The effective set is the
  allowlist **∪ {ToolSearch}**; it only loads schemas for other tools, which
  stay disabled, so it is not a boundary hole.
- A tool that attaches mid-session reaches `list_tools` about a second after
  `mcp_status_changed` announces its server, so the recompute is scheduled
  rather than immediate — a synchronous one reads a list the tool is not in yet
  and it stays allowed.
- Foundry's own MCP tools (`foundry___report_progress`,
  `foundry___read_phase_context`) are always folded into the allow set when a
  roster restricts tools. Wire ids use a triple underscore.

### Foundry MCP tools (`sdk/mcp-tools.ts`)

Every droid RPC session attaches an in-process foundry MCP server at
**create/resume** via init-time `mcpServers` — never `session.addMcpServer()`,
which permanently writes `~/.factory/mcp.json`. The server is a loopback HTTP
listener the SDK starts and stops with the session.

Exactly two tools, registered with the **typed** `tool()` overload and the
SDK's nested zod 3 (`sdk/sdk-zod.ts` — the only place that import lives; app
zod 4 must never reach `tool()`). The schema-less overload is defective in
0.7.0 (no inputSchema → handler gets the MCP extra and fires twice).

- `report_progress({summary})` → tracer `log` event named `{agent}: progress`
- `read_phase_context({})` → JSON of this run's validated envelope chain

Handlers close over Tracer + run context injected through `SdkSessionOptions.foundryMcp`.
They never write the worktree. They are not gate/acceptance tools.

## Discovery is session-first (`catalog.ts`)

Three layers, cheapest first, each allowed to correct the one under it: the
`droid exec --help` scrape, then whatever a live session reported, then
`settings.json` on top (the only source of a custom model's reasoning efforts).
Only the first two cost a subprocess or a disk read, so only they are cached —
a session that starts after a refresh still reaches the next reader.

Tools have **no session-free source at all**. `droid exec --list-tools` is gone:
a session's `listTools()` is both cheaper (no child) and more accurate (it
reports what actually applied, complement included — see the allowlist section),
so `AgentSession` publishes its models and tool set to the catalog right after a
session starts and `droidAdapter.tools` reads the last one. Cold start therefore
answers `[]` — the honest answer for a question only a session can answer, and
`catalog:tools` resolving to an empty array is not an error state. Changing the
droid path invalidates the session layer with the scrape: a different install's
tools are not this one's.

## Zero-interrupt policy (`permissions.ts`)

Runs never stop for a person. `evaluate()` ALWAYS returns a decision — there is
no "ask a human" outcome and no autonomy setting; `AUTONOMY_LEVEL` in
`protocol.ts` is the single level every session runs at, sent explicitly on
every create/resume (the argv `--auto high` is cosmetic — see the SDK seam).

The table: commands allow; in-worktree in-boundary writes allow; boundary
violations and protected paths deny; **out-of-worktree writes deny** (this ask
is the only thing guarding the base checkout, since the post-hoc git diff only
sees inside the worktree); a known write tool whose ask carries **no readable
path denies** for the same reason — an unreadable target may be outside the
worktree, and unmatched-tool allow would wave it through; an unmatched tool
allows. `ask_user` is auto-answered with each question's first option. Every
branch is traced as an `interrupt` event with `auto: true` and a reason.

Those answers ride on the `PermissionDecision` (`{outcome:'allow', answers}`),
not beside it: the decision is the whole of what `AgentSession.decide()` hands
a transport, and an ask_user allow that arrives without answers is replied to
as `{cancelled:true}` — which the CLI reads as a refusal, so the agent asks
again. Tests for this must assert the reply the agent RECEIVED, not the traced
interrupt payload; the trace stayed green through exactly that bug.

Allowing in-turn is safe because acceptance is post-hoc: `engine/boundary.ts`
diffs git after the phase and reverts what was not allowed. `InterruptRequest`
is now engineer-phase only — those are pipeline content, not permissions.

The SDK speaks selections rather than allow/deny, so `sdk/session.ts` adapts
both directions: its permission handler flattens `params.toolUses[0]` (the
tool's `input` plus the typed confirmation `details`) into the flat shape
`evaluate()` reads, then maps allow → `proceed_once` and deny →
`{selectedOption:'cancel', comment: reason}`. Its ask_user handler returns the
policy's answers verbatim; `cancelled` is reserved for a decision that has no
answers at all and never used for an ordinary question.
