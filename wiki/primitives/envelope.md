# Envelope

An envelope is the typed JSON report an agent phase must produce. Context crosses a phase boundary only as a validated envelope (plus optional handoff files). The engine parses the reply, retries on shape failure, then feeds the envelope to [gates](gate.md).

Contract kind: `EnvelopeKind` in `apps/desktop/src/shared/types.ts`. Implementation: `apps/desktop/src/main/engine/envelopes.ts` (zod schemas, extraction, corrections, prompt examples).

## EnvelopeKind

| Kind | Typical agent | Extra fields beyond base |
|---|---|---|
| `generic` | ad-hoc / prompt pipeline | (none) |
| `plan` | planner | `commit_message` |
| `build` | builder | `changed_files`, `commit_message` |
| `scout` | scout | `findings: string[]` |
| `review` | reviewer | `approved`, `findings: { requirement, met, evidence }[]`, `blocking` |
| `document` | documenter | `document_path`, `documented_files` |

## Base fields (every kind)

| Field | Type | Role |
|---|---|---|
| `status` | `'success' \| 'fail'` | Agent's self-report; acceptance may still require more |
| `summary` | `string` | One-line outcome |
| `artifacts` | `string[]` | Paths the agent claims to have produced (gates often verify these) |
| `notes_for_next_agent` | `string` | Free-form handoff text for later phases |

Zod defaults empty strings and empty arrays where safe so partial-but-valid objects still parse. `review.approved` is required (boolean) with no default.

## Kind-specific fields

| Kind | Fields |
|---|---|
| `plan` | `commit_message` |
| `build` | `changed_files`, `commit_message` |
| `scout` | `findings: string[]` |
| `review` | `approved: boolean`, `findings: { requirement, met, evidence }[]`, `blocking: string[]` |
| `document` | `document_path`, `documented_files` |

Custom agent fields (`AgentDef.customFields`) compile into the same schema and example path: name, type (`string` \| `number` \| `boolean` \| `string[]`), required flag, optional description.

## Zod and parse path

`schemas` maps each `EnvelopeKind` to a zod object. `schemaFor(kind, custom?)` extends the base with custom fields. `parseEnvelope(text, kind, custom?)`:

1. `extractJson` pulls the last balanced JSON object (fenced blocks preferred, final answer wins over earlier prose fences).
2. `JSON.parse`, then `safeParse` against the schema.
3. On failure: `ParseOutcome` with a specific `problem` string for the correction prompt.

A valid parse still does not mean phase success. Gates, write boundary, and envelope `status` are separate.

## Schema-generated examples in prompts

The synced-triad problem (type ↔ prompt example ↔ parse site) is solved by construction:

- `exampleFor(kind, custom?)` walks the same zod shape keys and fills human-facing hints (`FIELD_HINTS`).
- Review `findings` get a structured hint object, not a bare string.
- Custom fields use `description` or a type-based placeholder.
- The JSON example is **appended at render time**, not hard-coded into builtin agent prompts, so the shape shown and the shape parsed cannot drift.

`correctionMessage` restates the problem and reprints that example, asking for JSON only.

## Feedback envelopes

When a code phase fails with `feedbackTo`, the engine builds a synthetic envelope (`feedbackEnvelope`) carrying `status: 'fail'`, a summary with exit code, and the command output tail in `notes_for_next_agent`. That evidence is rendered into the agent phase as the `feedback` input so the builder does not have to rediscover the log.

## Trace

`EnvelopeRow` stores `payload`, `schemaKind`, `valid`, `attempt`, and linkage to `runId` / `phaseId`. Invalid attempts remain visible so retries stay honest in the trace.

## Related

- [Phase](phase.md)
- [Gate](gate.md)
- [Agent](agent.md)
- [Envelopes and gates](../features/envelopes-and-gates.md)
- [Engine](../systems/engine.md)
