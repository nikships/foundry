# Agent CLI

## Active contributors

Foundry maintainers

## Purpose

Foundry drives Factory Droid (`droid`) as its agent execution harness.

`src/main/cli/` is the seam that interfaces with the CLI adapter. It handles building argv for turns and parsing the stdout/stderr process output. Everything else — process spawning, timeouts, session carry-over, retries, envelopes, gates, and write boundaries — is managed deterministically by the engine.

This layer does not own sequencing or acceptance; those live in the [engine](engine.md). Droid's JSON-RPC client and the shared one-shot runner live in the [droid harness](droid.md).

## Directory layout

All paths under `apps/desktop/src/main/cli/`:

| File | Role |
|---|---|
| [`types.ts`](../../apps/desktop/src/main/cli/types.ts) | The `CliAdapter` interface, `TurnRequest`, `ParsedTurn`, and JSON parse helpers |
| [`index.ts`](../../apps/desktop/src/main/cli/index.ts) | Adapter registry and PATH lookup |
| [`droid.ts`](../../apps/desktop/src/main/cli/droid.ts) | Factory Droid CLI adapter |

## The adapter contract

```ts
turn(req: TurnRequest): { argv: string[] }
parse(out: ProcessOutput): ParsedTurn | null
```

`ParsedTurn` is `{ text, usage, sessionId, reason, isError }`. The `sessionId` is echoed back so the next turn resumes rather than starting cold. A `null` from `parse` means "nothing parseable", which the runner treats as an error only when the exit status was also non-zero.

## Invariants

- Autonomy maps directly to `--auto` for Factory Droid.
- RPC support (`supportsRpc`) provides live mid-turn tool visibility via JSON-RPC streaming.
- `droid exec` prints usage in snake_case (`input_tokens`) while its RPC surface sends camelCase (`inputTokens`), mapped cleanly by the parser.

## Configuration

`AppSettings.clis` holds `{ path, extraArgs }` for Factory Droid, resolved from PATH at launch and editable in **Settings, Agent CLI**.
