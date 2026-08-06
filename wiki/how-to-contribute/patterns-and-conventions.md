# Patterns and conventions

Coding rules that keep Foundry honest when agents, git, and the UI all touch the same run.

## Comments explain why

Comments state the constraint behind a decision, not a restatement of the next line. Load-bearing examples live next to the droid protocol quirks, earned-success defaults, and IPC structured-clone handling. Match that style; do not narrate obvious code.

## No emoji in source or UI copy

UI strings, logs, and commits in this app tree stay plain text. Prefer a comma or parenthesis over an em dash in prose and UI strings.

## IPC is structured-cloned

Anything sent over Electron IPC must be plain data. `src/renderer/api.ts` routes arguments through `plain()` so a wrapped object cannot fail to serialize (that failure surfaces only as a button that appears to do nothing). The full capability list is `src/shared/ipc-contract.ts`.

## Error surfaces stay honest

- A handler that can reject must catch and show the error. Silence reads as a bug.
- Unreported model usage displays as unreported, not zero.
- Unknown gate names fail the phase.
- A policy-blocked model degrades with a warning instead of killing the session.

## Engine invariants (do not break)

1. **A phase is born `fail`.** Flip to success only on clean exit (+ envelope + gates for agent phases).
2. **Code owns sequencing, retries, and acceptance.** Agents never decide success.
3. **Corrections re-prompt the same live session.** Envelope retries and gate retries have separate budgets.
4. **Gates return evidence**, one `GateCheck` per examined item.
5. **Write boundaries are enforced in code after the call** by diffing git status; unauthorized writes are reverted.
6. **`finish()`** settles status, notification, banner, and `outcome_detail` together.
7. Runs use a git worktree; the base checkout is never mutated by the engine.

## Builtins are seeds

Five agents and seven pipelines ship as builtins. User-edited copies live in the JSON store. Changing the builtin list must never clobber a user's copy.

## Trace stays normalized

Per-phase cost, duration, and model are **derived** from events in `src/renderer/derive.ts`, not denormalized onto `phases` columns. Do not add a `total_tokens` column to phases to "simplify" the UI.

## Droid protocol quirks (observed, not docs)

Encoded in `src/main/droid/protocol.ts` and enforced by `tests/fake-droid.ts`:

1. Frames need a `type` discriminator plus Factory API/protocol version fields. Plain JSON-RPC is rejected with `-32700`.
2. Request `id` must be a **string**. Numeric ids are rejected the same way.
3. Session settings (`modelId`, reasoning effort, autonomy) are **flat params** on `droid.update_session_settings`. Nested under `settings` they are silently ignored.

Also: `add_user_message` takes `params.text` (not `message`) and returns immediately; the turn ends with `agent_turn_completed`. `tool_call` is re-emitted per `toolUseId` as arguments stream, so the client folds them into one span.

## Testing style

Tests use real git repositories in `mkdtemp` directories and a scripted droid stub. No network, no model in the loop. New engine behaviour needs a test in that style. See [Testing](testing.md).

## SSSF skill is not a dependency

Do not import from, execute, or link against `.claude/`. Do not add Python to `apps/desktop/`. Read the skill to understand a concept, then implement it in TypeScript.
