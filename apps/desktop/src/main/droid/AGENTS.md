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
per `toolUseId` — fold into one span. `oneshot.ts` must stay vendor-agnostic;
vendor flags belong in `cli/<vendor>.ts`. Test against `tests/fake-droid.ts`.
