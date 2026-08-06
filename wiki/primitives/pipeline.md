# Pipeline

A pipeline is data, not a script: an ordered list of [phases](phase.md) plus an acceptance criterion that decides whether a finished run is `accepted` or `rejected`. Operators pick a pipeline; the TypeScript engine executes it.

Type: `PipelineDef`, `Acceptance` in `apps/desktop/src/shared/types.ts`. Seeds: `apps/desktop/src/main/store/builtin-pipelines.ts`. Runner: `apps/desktop/src/main/engine/executor.ts`.

## PipelineDef

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable key (for example `plan-build-test`) |
| `name` | `string` | Display name |
| `description` | `string` | What the chain is for |
| `acceptance` | `Acceptance` | How the run is judged after phases finish |
| `phases` | `PhaseDef[]` | Ordered steps |
| `isolation` | `boolean?` | See [isolation](#isolation) |
| `builtin` | `boolean?` | Shipped seed; user edits live as a separate store copy |

Builtins are seeds. Changing the builtin list must never clobber a user's edited copy in the store.

## Acceptance variants

```ts
type Acceptance =
  | { kind: 'phase_flag'; phase: string; flag: 'passed' | 'approved' }
  | { kind: 'all_phases_pass' }
  | { kind: 'last_phase_pass' }
  | { kind: 'envelope_status'; phase: string };
```

| Kind | Accepted when |
|---|---|
| `all_phases_pass` | Every phase is `success` or `skipped` |
| `last_phase_pass` | Final phase status is `success` |
| `phase_flag` + `passed` | Named phase succeeded, and if it was a code phase, command exit 0 |
| `phase_flag` + `approved` | Named phase succeeded and its envelope has `approved === true` (review) |
| `envelope_status` | Named phase succeeded and its envelope `status === 'success'` |

The reason string travels with the verdict so the banner can say *what* was checked. Acceptance is settled only inside `finish()` together with status, notification, and `outcome_detail`.

A run can still end `failed` or `killed` before acceptance runs (abort, crash, kill). Acceptance distinguishes clean completion: `accepted` vs `rejected`.

## Isolation

```ts
const isolate = pipeline.isolation !== false && project.isolation;
```

- When isolation is on, the run gets a git worktree and a `foundry/run_*` branch. The base checkout is never mutated by the engine.
- Pipeline `isolation: false` opts a chain out (docs-only or read-only pipelines such as **Prompt** and **Scout**).
- Project-level `isolation: false` also disables worktrees for that project.
- Default when the field is omitted: treat as isolating (only an explicit `false` opts out).

## Seven builtins

| id | Name | Acceptance | Isolation |
|---|---|---|---|
| `prompt` | Prompt | `last_phase_pass` | off |
| `scout` | Scout | `envelope_status` on `scout` | off |
| `plan` | Plan | `envelope_status` on `plan` | default on |
| `plan-build` | Plan → Build | `envelope_status` on `build` | default on |
| `plan-build-test` | Plan → Build → Test | `phase_flag` test / `passed` | default on |
| `plan-build-review` | Plan → Build → Review | `phase_flag` review / `approved` | default on |
| `full-sdlc` | Full SDLC | `phase_flag` review / `approved` | default on |

Typical agent/code mix: plan and build envelopes, `git_commit` builtins with `messageFrom`, project `test` ref with `feedbackTo: 'build'`, review gates, optional document + commit docs.

## Related

- [Phase](phase.md)
- [Envelope](envelope.md)
- [Gate](gate.md)
- [Agent](agent.md)
- [Pipelines](../features/pipelines.md)
- [Roster](../features/roster.md)
- [Engine](../systems/engine.md)
