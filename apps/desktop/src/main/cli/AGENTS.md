# AGENTS.md — src/main/cli

Adapters build argv and parse output for CLI execution. `types.ts` defines the seam,
and `index.ts` provides the registry. Factory Droid (`droid`) is the supported CLI provider.

This directory owns the **one-shot** seam only: argv in, text out, per vendor.
It owns no wire framing. RPC turns go through `@factory/droid-sdk` behind
`droid/sdk/session.ts`, which is also the only place that may import the SDK.

## Invariants

- Only droid sets `supportsRpc`. The flag means "there is an SDK transport for
  this vendor", not "this adapter speaks a protocol" — `supportsRpc` vendors
  still use the argv/parse path below whenever a session degrades to one-shot.
- droid's two output formats end differently: `-o json` prints
  `{"type":"result","result":...}`, `-o stream-json` prints
  `{"type":"completion","finalText":...}`. `parse()` accepts both — matching
  only the first leaves every streamed turn with empty text.
- `droid exec` prints usage in snake_case (`input_tokens`) while its RPC
  surface sends camelCase (`inputTokens`). Passing the wire object straight
  through reports every one-shot turn as free.

Fixtures in `tests/cli-vendors.test.ts` come from real captured output.
