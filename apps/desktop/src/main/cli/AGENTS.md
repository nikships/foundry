# AGENTS.md — src/main/cli

Adapters build argv and parse output for CLI execution. `types.ts` defines the seam,
and `index.ts` provides the registry. Factory Droid (`droid`) is the supported CLI provider.

## Invariants

- Only droid sets `supportsRpc`.
- droid's two output formats end differently: `-o json` prints
  `{"type":"result","result":...}`, `-o stream-json` prints
  `{"type":"completion","finalText":...}`. `parse()` accepts both — matching
  only the first leaves every streamed turn with empty text.
- `droid exec` prints usage in snake_case (`input_tokens`) while its RPC
  surface sends camelCase (`inputTokens`). Passing the wire object straight
  through reports every one-shot turn as free.

Fixtures in `tests/cli-vendors.test.ts` come from real captured output.
