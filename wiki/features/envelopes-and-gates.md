# Envelopes and gates

Envelopes and gates are the product surface that makes agent work checkable. An **envelope** is the typed JSON an agent must return at the end of a phase. A **gate** is a pure checker over that envelope (and the worktree) that returns **evidence**: one check per item examined, not a bare yes/no.

Agents never decide whether they succeeded. The engine parses the envelope, runs gates, and only then may flip the phase from its birth status of `fail` to success.

## Why it exists

Without typed seams, phase handoffs are free-form chat and the next agent guesses. Without gates, claims like "I wrote the plan" or "I changed these files" are trusted. Foundry treats both as code-owned: parse-or-correct, then evidence-or-correct, on the same live droid session.

## Envelope kinds

Zod schemas in `apps/desktop/src/main/engine/envelopes.ts`. All kinds share a base; specialised fields extend it.

### Base fields

| Field | Role |
|---|---|
| `status` | `success` or `fail` (agent's self-report; not the phase outcome). |
| `summary` | One sentence on what happened. |
| `artifacts` | Relative paths the agent declares it produced. |
| `notes_for_next_agent` | Handoff text for later phases. |

### Kind-specific fields

| Kind | Extra fields | Typical owner |
|---|---|---|
| `generic` | base only | Prompt / ad-hoc agents |
| `plan` | `commit_message` | planner |
| `build` | `changed_files`, `commit_message` | builder |
| `scout` | `findings[]` (strings) | scout |
| `review` | `approved`, `findings[{requirement, met, evidence}]`, `blocking[]` | reviewer |
| `document` | `document_path`, `documented_files` | documenter |

Custom agents may add fields via the roster's constrained editor (`string` / `number` / `boolean` / `string[]`). Custom fields compile into the same schema and into the prompt example.

### Synced triad

The JSON example embedded in the agent prompt is **generated from the schema** (`exampleFor`) at render time. The parse path uses the same schema (`schemaFor`). Type, prompt example, and call site cannot drift by construction.

### Corrections

If the final agent text does not parse:

1. The engine records a correction (reason named exactly).
2. It re-prompts the **same** live session (not a cold restart).
3. Budget: app setting `envelopeRetries` (default 3).

Failed gates use a separate budget (`gateRetries` / phase `retries`). Envelope and gate retries do not share a counter.

## Six gates

Implemented in `apps/desktop/src/main/engine/gates.ts`. An unknown gate name fails with an explicit check: nothing verified it.

| Gate | What it verifies | Evidence shape |
|---|---|---|
| `artifacts_exist` | Every path in `artifacts` exists on disk in the worktree. | One check per path: exists + size, or missing. Empty list → "nothing to verify". |
| `files_non_empty` | Declared artifact files have content (directories ok). | Per file: size note or empty failure. |
| `json_parses` | Declared `.json` artifacts parse as JSON. | Per file: type/array note or parse error. |
| `diff_matches_claims` | Build claims vs git: claimed files exist; unclaimed changes fail. | Per claimed path + optional unclaimed-changes failure. |
| `verdict_consistent` | Review self-consistency: cannot `approved` with blocking or unmet findings; rejection must name a problem. | Checks: approved vs blocking, approved vs findings, rejection supported. |
| `command_passes` | Configured `argv` exits 0 in the worktree (generalisation of "tests pass"). | Single check: command label, exit, timing or tail of output. |

Gates resolve paths against the **worktree cwd**, not the base checkout. `diff_matches_claims` uses the set of paths git reports as changed since the phase started.

### Evidence UX

Gate results are stored as `gate_results` rows (`passed` plus `checks_json`). On Run detail → phase drawer → **Gates**:

- Gate name and overall pass/fail badge.
- List of checks: mark, mono `item`, human `note`.
- A green gate still shows *what* it verified (paths, sizes, "git agrees nothing changed"), not only a checkmark.

Corrections and gate failures appear on the timeline as distinct event types so retries are visible, not buried.

## How a phase uses both

For an agent phase the engine roughly:

1. Render prompt (request, prior envelopes, schema example).
2. Send turn on the agent's live session; collect final text.
3. Parse envelope → on failure, correct and retry (envelope budget).
4. Run configured gates → on failure, correct and retry (gate budget).
5. Enforce write boundary (separate from gates).
6. Only then mark the phase success.

Pipeline designer validation rejects unknown gate names and requires argv for `command_passes`. See [Pipelines](pipelines.md).

## Related

- [Envelope primitive](../primitives/envelope.md)
- [Gate primitive](../primitives/gate.md)
- [Roster](roster.md)
- [Runs and traces](runs-and-traces.md)
- [Engine](../systems/engine.md)
- [Design invariants](../background/design-invariants.md)

## Active contributors

Foundry maintainers.
