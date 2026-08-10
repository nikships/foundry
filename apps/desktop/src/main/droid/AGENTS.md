# AGENTS.md — src/main/droid

Droid's JSON-RPC client + shared one-shot runner. `protocol.ts` encodes
findings observed against the real CLI, not the docs.

## Three quirks a naive client gets wrong

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
stay vendor-agnostic; vendor flags belong in `cli/<vendor>.ts`. Test against
`tests/fake-droid.ts`.

## The SDK seam (`sdk/`)

`sdk/session.ts` is the only place `@factory/droid-sdk` may be imported (ESLint
enforces it; tests/sdk-\*.test.ts are the one other exception). Everything
else talks to `SdkSession`, so the transport stays swappable.

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

Two more SDK behaviours the code works around: `--auto` is inert for a
stream-jsonrpc session (only `autonomyLevel` decides, and omitting it defaults
to high, which is why it is always sent), and the SDK's stderr goes through a
logger that strips message text from any customer sink — so `sdk/session.ts`
reads `childProcess.stderr` directly.

## Zero-interrupt policy (`permissions.ts`)

Runs never stop for a person. `evaluate()` ALWAYS returns a decision — there is
no "ask a human" outcome and no autonomy setting; `AUTONOMY_LEVEL` in
`protocol.ts` is the single level every session runs at, sent explicitly on
every create/resume and passed as `--auto high` on every spawn.

The table: commands allow; in-worktree in-boundary writes allow; boundary
violations and protected paths deny; **out-of-worktree writes deny** (this ask
is the only thing guarding the base checkout, since the post-hoc git diff only
sees inside the worktree); an unmatched tool allows. `ask_user` is auto-answered
with each question's first option. Every branch is traced as an `interrupt`
event with `auto: true` and a reason.

Allowing in-turn is safe because acceptance is post-hoc: `engine/boundary.ts`
diffs git after the phase and reverts what was not allowed. `InterruptRequest`
is now engineer-phase only — those are pipeline content, not permissions.
