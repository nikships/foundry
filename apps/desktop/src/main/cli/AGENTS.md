# src/main/cli

Adapters own vendor argv construction and one-shot output parsing only.
`types.ts` is the seam and `index.ts` is the registry. RPC wire behavior is in
`droid/sdk/`, not here.

## Droid-specific compatibility

- Only Droid sets `supportsRpc`; it means an SDK transport exists, not that
  this adapter owns protocol framing. A degraded session still uses argv/parse.
- `droid exec -o json` ends with `result`, while `-o stream-json` ends with
  `completion` and `finalText`; `parse()` must accept both.
- One-shot usage reports `input_tokens` but RPC reports `inputTokens`; map the
  fields before recording token usage.
- `models()` is a subprocess. `tools()` reads the last live session catalog,
  ignores the passed binary/model, and is honestly empty before a session runs.

Keep vendor flags in the vendor adapter and fixtures in
`tests/cli-vendors.test.ts`; do not add wire framing here.
