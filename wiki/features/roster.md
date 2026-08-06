# Roster

The roster is the set of agents Foundry can schedule into pipeline phases. It is app state with a full editor, not a hand-edited YAML file. Agents are JSON documents (`AgentDef`); sharing one is sending a file.

## Why it exists

Tuners swap models, tighten write boundaries, and edit prompts without touching engine code. Operators see a stable cast (planner, builder, scout, …) with emblems and lane colours on the waterfall. Builtins ship as seeds so a fresh install can run every built-in pipeline immediately.

There is no tester agent. Running a test suite is a known command and therefore a `code` phase.

## Built-in agents

Five seeds in `apps/desktop/src/main/store/builtin-agents.ts`:

| Name | Purpose (one line) | Envelope | Writes | Default model / effort |
|---|---|---|---|---|
| `planner` | Turn a request into a plan the builder needs no questions to implement. | `plan` | `specs/`, `.foundry-handoff/` | claude-opus-5 / high |
| `builder` | Implement the plan exactly; report every file changed. | `build` | unrestricted (`null`) | claude-opus-5 / medium |
| `scout` | Map the ground before anyone changes it. Read-only. | `scout` | read-only (`[]`) | claude-sonnet-5 / medium |
| `reviewer` | Confirm what was built is what was asked for. Not testing. | `review` | read-only (`[]`) | claude-opus-5 / high |
| `documenter` | Write down what changed for the human who arrives later. | `document` | `docs/`, `README.md` | claude-sonnet-5 / medium |

Each agent owns system and user prompt templates with variables such as `{{request}}` and prior envelopes. The JSON example of the expected envelope is **not** hand-written into those prompts: it is generated from the zod schema at prompt-render time so the shape shown and the shape parsed cannot drift. See [Envelopes and gates](envelopes-and-gates.md).

## AgentDef

| Field | Meaning |
|---|---|
| `name` | Lowercase id (`^[a-z][a-z0-9_-]*$`). |
| `purpose` | One line for UI and prompt context. |
| `model` | Catalog id or `inherit` (app default). BYOK custom models appear as `custom:…`. |
| `reasoningEffort` | `off` / `low` / `medium` / `high` (droid levels). |
| `systemPrompt`, `userPrompt` | Markdown templates. |
| `writes` | Write boundary: `null` unrestricted (in worktree), `[]` read-only, or path/glob list. |
| `envelope` | Base kind: `generic`, `plan`, `build`, `scout`, `review`, `document`. |
| `customFields` | Optional extra envelope fields (string / number / boolean / string[]). |
| `tools`, `disabledTools` | Optional droid tool policy. |
| `color`, `emblem` | Lane colour and roster art. |
| `builtin` | Seed origin marker. |

## Roster editor UI

Screen: `apps/desktop/src/renderer/screens/RosterScreen.tsx`.

- Card list with emblem, name, purpose; **New**, select, edit draft.
- **Model picker** (`ModelPicker`): searchable catalog with provider icons, context window, BYOK badge. Catalog is loaded from droid (`catalog.models`) and can be refreshed.
- **Reasoning effort** segmented control.
- **Purpose**, system and user prompts, with template-token hints and **prompt preview** (`PromptPreview`) against sample context.
- **Envelope** base kind; optional custom fields for extended schemas.
- **Write boundary** (`BoundaryEditor`): three explicit modes.
- Duplicate, delete, save with inline validation issues.

### Write boundaries UI

Three-state control, matching engine enforcement:

| Mode | Stored value | Meaning |
|---|---|---|
| Anywhere in the worktree | `null` | Writes inside the worktree kept; outside always reverted. |
| Only these paths | non-empty string list | Globs (`*`, `**`); writes outside are reverted and the phase fails. |
| Read-only | `[]` | Every write reverted after the phase; used for scout and reviewer. |

Enforcement is in code after the agent call: snapshot git status, classify, revert unauthorized paths, fail with evidence. See [Design invariants](../background/design-invariants.md) and [Engine](../systems/engine.md).

### Models catalog

- Seeded / refreshed via droid list-tools and Factory models metadata.
- BYOK entries from `~/.factory/settings.json` `customModels`, offered as `custom:{DisplayName}-{index}` with a BYOK badge.
- Unknown-but-typed model ids are allowed with a warning; droid is authoritative. Failure surfaces on first turn, attributed to the phase.
- App-level default model and effort live in Settings → Agent defaults; agents may set `inherit`.

## Builtin seed rule

Builtins are seeds. A user's edited copy lives in their own store (`roster.json` under app support, or a per-project override when `ownRoster` is true).

Load behaviour:

- App roster is initialised from `BUILTIN_AGENTS`.
- On read, any **missing** shipped agent name is restored so built-in pipelines that name it do not break.
- A change to the builtin list must **never clobber** fields a user already edited for an existing name.
- Duplicate creates a non-builtin copy with a unique name.
- `resetToBuiltins()` is the explicit path back to stock seeds.

Projects can toggle "this project uses its own roster copy"; lookup is project-then-app when that flag is on.

## Related

- [Agent primitive](../primitives/agent.md)
- [Pipelines](pipelines.md)
- [Envelopes and gates](envelopes-and-gates.md)
- [Store](../systems/store.md)
- [Droid harness](../systems/droid.md)

## Active contributors

Foundry maintainers.
