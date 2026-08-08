# AGENTS.md — src/main/cli

One file per vendor + `types.ts` interface + `index.ts` registry. Adding a
sixth CLI is one file + one registry entry — nothing in `engine/` changes.
`droid/oneshot.ts` owns spawn/timeout/kill/line-splitting; adapters only build
argv and parse output. Optional `stream()` maps streaming-JSON lines to
droid-shaped notifications.

## Invariants

- Autonomy is a sandbox tier, never an approval prompt. A CLI left in "ask the
  human" mode blocks on stdin nobody types into — every adapter except droid
  disables approvals and confines instead. Write boundary still diffs git after.
- Never invent a flag or model id. Junie publishes no headless flag (so its
  adapter emits none; doctor checks `~/.junie/allowlist.json`). A vendor with
  no published model list returns only documented aliases + `inherit`. Wrong ids
  are accepted then yield empty turns.
- Unreported usage stays `null`, not `0`. Codex and Grok both return `null`.
- Only droid sets `supportsRpc`.
- droid's two output formats end differently: `-o json` prints
  `{"type":"result","result":...}`, `-o stream-json` prints
  `{"type":"completion","finalText":...}`. `parse()` accepts both — matching
  only the first leaves every streamed turn with empty text.
- `droid exec` prints usage in snake_case (`input_tokens`) while its RPC
  surface sends camelCase (`inputTokens`). Passing the wire object straight
  through reports every one-shot turn as free.

Fixtures in `tests/cli-vendors.test.ts` come from real captured output
(`--output-format stream-json`, `--json`, `streaming-json`, `json-stream`),
including Codex's two spellings of its item discriminator — don't use shapes
the parser finds convenient.
