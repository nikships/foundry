# Agent

An agent is a roster definition: who runs an agent [phase](phase.md), with which model, prompts, tools, [envelope](envelope.md) kind, and write boundary. Builtins are seeds; every field is editable in the Roster UI, and user copies live in the store.

Type: `AgentDef`, `WriteBoundary`, `CustomEnvelopeField` in `apps/desktop/src/shared/types.ts`. Seeds: `apps/desktop/src/main/store/builtin-agents.ts`. Boundary enforcement: `apps/desktop/src/main/engine/boundary.ts`.

## AgentDef

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Roster key referenced by `PhaseDef.agent` |
| `purpose` | `string` | Short human summary |
| `model` | `string` | Model id passed into droid session settings |
| `reasoningEffort` | `ReasoningEffort` | `'off' \| 'low' \| 'medium' \| 'high'` |
| `systemPrompt` | `string` | System side of the turn |
| `userPrompt` | `string` | User template; placeholders like `{{request}}`, `{{envelope:plan}}` |
| `writes` | `WriteBoundary` | Three-state allow list (below) |
| `envelope` | `EnvelopeKind` | Schema used for parse + example generation |
| `customFields` | `CustomEnvelopeField[]?` | Extra envelope fields compiled into schema and example |
| `tools` | `string[]?` | Empty / omitted = droid default tool set for that model |
| `disabledTools` | `string[]?` | Tools to strip from the session |
| `color` | `string` | UI swim-lane colour |
| `emblem` | `string?` | Optional icon key |
| `builtin` | `boolean?` | Shipped seed; user edits are separate store rows |

The envelope JSON example is **not** baked into these prompts. It is generated from the zod schema at render time and appended so shown shape and parse shape cannot drift. See [Envelope](envelope.md).

## WriteBoundary (three-state)

```ts
type WriteBoundary = string[] | null;
```

| Value | Meaning |
|---|---|
| `null` | Unrestricted writes, except always-protected and project-protected paths |
| `[]` | Read-only: any new write is a violation |
| `string[]` | Allowlist of paths, prefixes, or globs |

Always protected regardless of agent boundary: `.foundry/`, `.git/`, `.foundry-worktrees/`. Project `protectedPaths` add more.

Enforcement is **after** the agent turn: snapshot git status at phase start, diff at end, classify each new change, **revert** unauthorized paths, fail the phase with the violation list, and re-prompt the same session with `boundaryCorrection`. The agent is not trusted to stay inside the fence.

Glob matching is intentionally narrow: `*` within a path segment, `**` across segments; trailing `/` means prefix under that directory.

## Model, effort, tools

- **Model** and **reasoningEffort** are session settings (flat params on `droid.update_session_settings` in the wire protocol). A policy-blocked model should degrade with a warning rather than killing the session.
- **tools** / **disabledTools** shape the droid tool set. Empty tools means the harness default for the model.
- App settings supply defaults (`defaultModel`, `defaultReasoningEffort`, `defaultAutonomy`) when a run does not override autonomy elsewhere; agents still carry their own model and effort.

`AutonomyLevel` (`low` \| `medium` \| `high`) is a run/settings concern for droid's outer auto level; write boundary is the inner, per-agent fence.

## Five builtins

| Name | Envelope | Writes | Effort | Role |
|---|---|---|---|---|
| `planner` | `plan` | `specs/`, `.foundry-handoff/` | high | Spec concrete enough to implement without questions |
| `builder` | `build` | `null` (unrestricted minus protected) | medium | Implement plan; list every changed file |
| `scout` | `scout` | `[]` (read-only) | medium | Evidence-backed codebase answers |
| `reviewer` | `review` | `[]` (read-only) | high | Requirements vs diff; not a test runner |
| `documenter` | `document` | `docs/`, `README.md` | medium | Document what changed for later readers |

There is no tester agent: suites are `code` phases.

## Custom envelope fields

```ts
interface CustomEnvelopeField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required: boolean;
  description?: string;
}
```

Compiled in `schemaFor` / `exampleFor` on the same path as kind-specific fields.

## Related

- [Phase](phase.md)
- [Envelope](envelope.md)
- [Pipeline](pipeline.md)
- [Roster](../features/roster.md)
- [Envelopes and gates](../features/envelopes-and-gates.md)
- [Engine](../systems/engine.md)
