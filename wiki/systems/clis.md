# Agent CLIs

## Active contributors

Foundry maintainers

## Purpose

Foundry drives five coding-agent CLIs, and an agent picks one:

| Vendor id | CLI | Binary | Transport |
|---|---|---|---|
| `droid` | Factory droid | `droid` | JSON-RPC, with one-shot fallback |
| `claude` | Claude Code | `claude` | one-shot |
| `codex` | OpenAI Codex | `codex` | one-shot |
| `junie` | JetBrains Junie | `junie` | one-shot |
| `grok` | Grok Build (xAI) | `grok` | one-shot |

`src/main/cli/` is the seam that makes that possible. It answers one question per
vendor, twice: **what argv runs this turn**, and **what did the process just
print**. Everything else, which is process spawning, timeouts, session carry-over,
retries, envelopes, gates, and write boundaries, is shared and vendor-blind.

This layer does not own sequencing or acceptance. Those live in the
[engine](engine.md). Droid's JSON-RPC client and the shared one-shot runner live
in the [droid harness](droid.md).

## Directory layout

All paths under `apps/desktop/src/main/cli/`:

| File | Role |
|---|---|
| [`types.ts`](../../apps/desktop/src/main/cli/types.ts) | The `CliAdapter` interface, `TurnRequest`, `ParsedTurn`, and the JSON parse helpers |
| [`index.ts`](../../apps/desktop/src/main/cli/index.ts) | Registry, PATH lookup, per-vendor default config |
| [`droid.ts`](../../apps/desktop/src/main/cli/droid.ts) | `droid exec --output-format json` |
| [`claude.ts`](../../apps/desktop/src/main/cli/claude.ts) | `claude -p --output-format json` |
| [`codex.ts`](../../apps/desktop/src/main/cli/codex.ts) | `codex exec --json` (JSONL event stream) |
| [`junie.ts`](../../apps/desktop/src/main/cli/junie.ts) | `junie --output-format json` |
| [`grok.ts`](../../apps/desktop/src/main/cli/grok.ts) | `grok -p --output-format json` |

## The adapter contract

```ts
turn(req: TurnRequest): { argv: string[] }
parse(out: ProcessOutput): ParsedTurn | null
```

`ParsedTurn` is `{ text, usage, sessionId, reason, isError }`. The `sessionId` is
whatever that CLI calls a session, echoed back so the next turn resumes rather
than starting cold. A `null` from `parse` means "nothing parseable", which the
runner treats as an error only when the exit status was also non-zero.

## Invariants

### Autonomy is a sandbox tier, never an approval prompt

Nothing is watching a pipeline phase. A CLI left in its default "ask the human"
mode either blocks forever on a stdin nobody is typing into or aborts mid-turn.
Every adapter but droid therefore switches approvals off and confines the agent
instead:

| Autonomy | Claude Code | Codex | Grok | droid |
|---|---|---|---|---|
| low | `--permission-mode default` | `--sandbox read-only` | `--sandbox read-only` | `--auto low` |
| medium | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--sandbox workspace` | `--auto medium` |
| high | `--permission-mode bypassPermissions` | `--sandbox workspace-write` plus network | `--sandbox off` | `--auto high` |

Codex always gets `--ask-for-approval never`, and Grok always gets
`--always-approve`, because any other value waits on a human. Codex is never given
`danger-full-access`: the run is already isolated in a worktree, so turning the
sandbox off would remove the only guardrail and buy nothing.

This does not widen what an agent may write. The [write
boundary](../features/envelopes-and-gates.md) still diffs git after the turn, so a
sandbox wider than the agent's declared `writes` is caught and reverted exactly as
before. The sandbox is a first line, not the line.

Droid is the exception. Its RPC surface hands permission asks back to Foundry, so
`--auto` keeps its meaning and the interrupt sheet still opens mid-turn.

### Never invent a flag

Junie publishes no headless autonomy flag. Its brave mode is documented as an
interactive toggle, and its approval behaviour otherwise comes from
`~/.junie/allowlist.json`. The adapter therefore emits **no** autonomy flag, and
the doctor checks for that allowlist instead, so a missing setup shows up as a
setup check rather than as a phase that hangs. An operator whose build does accept
a flag can add it in Settings under the per-CLI extra arguments field, which is
appended verbatim to every turn.

### Never invent a model id

A CLI that publishes no model list gets only its documented aliases plus
`inherit`, which means "pass no model flag and take the CLI's own default". A
model id the CLI does not know is usually *accepted* and then yields empty turns,
which reads as a broken agent rather than as a bad setting. Model ids do not carry
across vendors, so changing an agent's CLI resets its model.

### Unreported usage stays unreported

Codex reports tokens but no cost. Grok's usage block is documented as present but
its field names are not published, so that adapter reads several spellings and
returns `null` when it recognises none. A `null` shows in the UI as unreported; a
zero would claim the turn was free.

## Configuration

`AppSettings.clis` holds one `{ path, extraArgs }` per vendor, resolved from PATH
at first launch and editable in **Settings, Agent CLIs**. `AppSettings.defaultCli`
is what a new agent starts on and what repo command detection uses.

A settings file written before this existed carries a single `droidPath`. The
store migrates it into `clis.droid.path` on read, so an operator who pointed
Foundry at a non-standard droid build keeps it.

`AgentDef.cli` is optional. Absent means `droid`, so rosters written before this
existed load unchanged.

## What one-shot costs

Every vendor but droid runs one process per turn, which means:

- **No mid-turn tool visibility.** A turn is one span in the trace instead of one
  span per tool call. Envelopes, gates, boundaries, cost, and session continuity
  all still work.
- **No interrupt sheet for permissions.** Autonomy is settled before the process
  starts, by the tier table above.

## Adding a sixth CLI

1. Write `src/main/cli/<vendor>.ts` exporting a `CliAdapter`.
2. Add it to `ADAPTERS` in `index.ts` and to `CliVendor` in `src/shared/types.ts`.
3. Add its argv and parse cases to `tests/cli-vendors.test.ts`.

Nothing in `engine/`, `trace/`, or the renderer needs to change.

## Future: bidirectional transports

Three of the four additions already speak a protocol shaped like
`droid/client.ts`, all JSON-RPC over stdio:

- Junie: `junie --acp true` (Agent Client Protocol)
- Grok: `grok agent stdio` (ACP)
- Codex: `codex app-server`, or `codex mcp-server` for the MCP framing

Claude Code has `--input-format stream-json` with `--output-format stream-json`
for the same effect. Turning any of these on means setting `supportsRpc` and
supplying a client; the engine's mode-fallback logic already handles the rest.
That would restore mid-turn tool visibility and, for ACP's
`session/request_permission`, the interrupt sheet.
