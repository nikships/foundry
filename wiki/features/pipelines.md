# Pipelines

A pipeline is a JSON document that lists ordered phases and an acceptance criterion. It is data, not a script: the engine interprets `PipelineDef` records, and the Pipelines screen is a designer over that shape. That is the main product departure from the SSSF skill, which stamped imperative ADW scripts per repo.

## Why it exists

Operators need the same plan → build → test shape the fortieth time as the first, without writing code to change order, model ownership, gates, or feedback loops. Tuners need to compose custom chains in the UI. Skeptics need a dry-run of the exact prompts that would be sent before spending a token.

## Data model

Defined in `apps/desktop/src/shared/types.ts` and seeded in `apps/desktop/src/main/store/builtin-pipelines.ts`.

### PipelineDef

| Field | Meaning |
|---|---|
| `id` | Stable identifier (e.g. `plan-build-test`). |
| `name` | Display name. |
| `description` | Human summary shown in the composer and designer. |
| `acceptance` | How the run becomes `accepted` vs not. |
| `phases` | Ordered `PhaseDef` list. |
| `isolation` | Optional. When `false`, the run may skip worktree isolation (docs-only / read-only chains). |
| `builtin` | Marks seed origin. Editable copy in the user's store is not locked. |

### Acceptance kinds

| Kind | Behaviour |
|---|---|
| `last_phase_pass` | Last phase succeeded. |
| `all_phases_pass` | Every phase succeeded. |
| `envelope_status` | Named phase's envelope reports success. |
| `phase_flag` | Named phase exposes `passed` (code/test) or `approved` (review). |

### PhaseDef

| Field | Applies to | Meaning |
|---|---|---|
| `name`, `description` | all | Identifier + explanation. Description must not merely echo the name (validated at edit time). |
| `kind` | all | `agent`, `code`, or `engineer`. |
| `agent`, `envelope`, `gates`, `prompt` | agent | Roster agent, envelope kind, gate list, prompt template + inputs. |
| `retries` | agent | Gate-failure re-prompt budget on the same session. |
| `command` | code | `ref` (project command), `builtin` (`git_commit`, `git_status`, `noop`), or raw `argv`. |
| `feedbackTo`, `feedbackRetries` | code | On failure, hand evidence back to an earlier agent phase. |
| `question` | engineer | Text for the human interrupt sheet. |
| `optional`, `timeoutMs` | code / shared | Soft fail and turn/command limits where set. |

Prompt inputs include `request` and prior envelopes as `envelope:{phaseName}` (optionally with a field path). The designer and validator require that envelope inputs name an earlier phase.

## Built-in pipelines

Seven seeds in `builtin-pipelines.ts`. Every one is an editable copy in the designer, not a locked recipe (`builtin` only marks origin).

| Id | Name | Shape (summary) | Isolation default |
|---|---|---|---|
| `prompt` | Prompt | One builder agent, `generic` envelope. Smallest useful run. | off |
| `scout` | Scout | Read-only scout agent + findings. Natural smoke run. | off |
| `plan` | Plan | Planner → commit plan. | project default (on) |
| `plan-build` | Plan → Build | Plan, commit plan, build, commit build. | project default |
| `plan-build-test` | Plan → Build → Test | Standard chain; test code phase feedbacks to build. | project default |
| `plan-build-review` | Plan → Build → Review | Second agent checks against request; acceptance on `approved`. | project default |
| `full-sdlc` | Full SDLC | Plan, build, test, review, document, with commits at meaningful boundaries. | project default |

Typical agent phases wire:

- Plan: `artifacts_exist`, `files_non_empty`
- Build: `diff_matches_claims`, retries 2
- Review: `verdict_consistent`
- Document: `artifacts_exist`, `files_non_empty`

Test phases use `command: { ref: 'test' }` and `feedbackTo: 'build'` with `feedbackRetries: 2`.

## Designer UI

Screen: `apps/desktop/src/renderer/screens/PipelinesScreen.tsx`.

- Left list of pipelines; select to edit a draft clone of the stored def.
- Vertical phase list with add agent / code / engineer, reorder, and per-phase inspector (`PhaseEditor`).
- Graph / ribbon of phases and feedback edges (`PipelineGraph`, `PipelineRibbon`).
- Acceptance criterion picker (kind, target phase, flag when relevant).
- Isolation toggle where the def allows opt-out.
- Save goes through the store; validation issues block or warn.

### Validation

`validate()` in `apps/desktop/src/main/store/pipelines.ts` runs on every draft change and on save. Examples:

- Schema errors from zod.
- Duplicate phase names.
- Description that only restates the phase name.
- Agent phases: missing agent/prompt, unknown agent or gate, `command_passes` without argv, envelope inputs that do not name an earlier phase.
- Code phases: missing command; project command ref not configured yet (warning); `feedbackTo` must point at an earlier agent phase.
- Acceptance naming a missing phase; `approved` on a non-review envelope (warning).

### Dry-run

Dry-run renders the exact system and user prompts each agent phase would receive against a sample request, without calling droid or spending tokens. The UI presents results in `DryRunSheet`: phase list with model, then full system and user text.

## Store and seeds

- Global pipelines: JSON under app support, seeded from `BUILTIN_PIPELINES`.
- Projects may set `ownPipelines` and keep an independent override copy.
- Changing the builtin list must never clobber a user's edited copy. Builtins are seeds; absence of a shipped id may be restored, but user fields are not overwritten by a seed refresh.

See [Store](../systems/store.md) and the seed rule in [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md).

## Related

- [Pipeline primitive](../primitives/pipeline.md)
- [Phase](../primitives/phase.md)
- [Roster](roster.md)
- [Envelopes and gates](envelopes-and-gates.md)
- [Engine](../systems/engine.md)
- [Runs and traces](runs-and-traces.md)

## Active contributors

Foundry maintainers.
