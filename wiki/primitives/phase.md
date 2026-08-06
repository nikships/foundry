# Phase

A phase is one ordered step in a [pipeline](pipeline.md). The engine runs phases sequentially; each has a kind, a required name and description, and kind-specific fields. Agents never decide whether a phase succeeded.

Types: `PhaseKind`, `PhaseStatus`, `PhaseDef` in `apps/desktop/src/shared/types.ts`. Runtime loop: `apps/desktop/src/main/engine/executor.ts`. Trace rows: `PhaseRow`.

## PhaseKind

| Kind | What runs | Success requires |
|---|---|---|
| `agent` | Droid session turn (reuse live session on retry) | Clean turn, parsed [envelope](envelope.md), green [gates](gate.md), write boundary clean |
| `code` | Known subprocess (project command ref, builtin, or raw argv) | Exit 0 (unless `optional`); optional feedback loop to an earlier agent phase |
| `engineer` | Human interrupt sheet in the UI | Engineer approves (optionally edits text) |

There is no tester agent: running a suite is a known command, so it is a `code` phase.

## PhaseStatus

```
queued → running → success | fail | skipped
```

| Status | Meaning |
|---|---|
| `queued` | Inserted for the run plan, not yet started |
| `running` | Opened for execution |
| `success` | Explicitly closed clean |
| `fail` | Closed dirty, or the honest default if nothing proved otherwise |
| `skipped` | Not required for this path (counts as non-failing for `all_phases_pass`) |

Schema default on `phases.status` is `'fail'`. The tracer comment states the rule: a phase row is born fail; success has to be earned by a clean finish. The executor flips to success only after the kind-specific checks pass. Never default a phase to success.

## PhaseDef fields

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Identifies the phase in the pipeline and in refs (`envelope:plan`, `feedbackTo`) |
| `kind` | `PhaseKind` | `agent` \| `code` \| `engineer` |
| `description` | `string` | Explains intent. Required; Designer rejects a description that only echoes the name |
| `agent` | `string?` | Roster agent name (agent phases) |
| `envelope` | `EnvelopeKind?` | Expected envelope schema (agent phases) |
| `gates` | `(string \| GateSpec)[]?` | Post-envelope checks; bare name or `{ gate, config? }` |
| `prompt` | `PromptSpec?` | `{ template, inputs }` for agent phases. Inputs include `request`, `envelope:<phase>`, `handoff_files`, `feedback` |
| `command` | `CommandSpec?` | Code phase process: `{ ref }`, `{ builtin, messageFrom? }`, or `{ argv }` |
| `retries` | `number?` | Agent-phase retry budget for that phase (envelope/gate budgets also come from settings) |
| `feedbackTo` | `string?` | On code-phase failure, send evidence back to this earlier agent phase |
| `feedbackRetries` | `number?` | How many times that repair loop may run |
| `question` | `string?` | Engineer phase: what the sheet asks the human |
| `timeoutMs` | `number?` | Per-phase timeout override |
| `optional` | `boolean?` | Code phases: non-zero exit is recorded but does not fail the run |

### CommandSpec

```
{ ref: string }                              // project.commands by name
{ builtin: 'git_commit' | 'git_status' | 'noop'; messageFrom?: string }
{ argv: string[] }                           // raw argv in the worktree cwd
```

`messageFrom` resolves a path into a prior envelope (for example `envelope:plan.commit_message`).

## Runtime row

`PhaseRow` is what the UI polls: `phaseId`, `runId`, `seq`, `name`, `kind`, `owner`, `description`, `status`, `attempt`, `error`, timestamps. Per-phase cost and model are **derived** from events, not stored on the phase row.

## Invariants

- Code owns sequencing, retries, and acceptance. An agent never decides phase success.
- Corrections re-prompt the **same live droid session** (envelope vs gate retries use separate budgets from settings).
- Write boundaries are enforced after agent phases by git status diff; unauthorized writes are reverted and the phase fails.
- `optional` code phases can fail the command without aborting the run; non-optional failures can abort or enter `feedbackTo` repair.

## Related

- [Envelope](envelope.md)
- [Gate](gate.md)
- [Pipeline](pipeline.md)
- [Agent](agent.md)
- [Envelopes and gates](../features/envelopes-and-gates.md)
- [Pipelines](../features/pipelines.md)
- [Engine](../systems/engine.md)
