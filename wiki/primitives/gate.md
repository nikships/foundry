# Gate

A gate checks an [envelope](envelope.md)'s **claims** against the worktree (and sometimes git status or a command). Gates return **evidence**, not a bare pass/fail: one `GateCheck` per item examined, so a green gate says *what* it verified.

Types: `GateSpec`, `GateCheck` in `apps/desktop/src/shared/types.ts`. Implementation: `apps/desktop/src/main/engine/gates.ts`.

## GateSpec

```ts
interface GateSpec {
  gate: string;
  config?: Record<string, unknown>;  // e.g. command_passes needs argv
}
```

A phase may list gates as bare strings or full specs. `normaliseGateSpec` turns a string into `{ gate }`.

## GateCheck and reports

```ts
interface GateCheck {
  item: string;  // path, logical item, or gate name
  ok: boolean;
  note: string;  // human-readable evidence
}
```

`runGates` produces a `GateReport` per spec: `{ gate, passed, checks }`. `passed` is true only when every check is `ok`. Violations for corrections are derived with `violationsOf` (`gate / item: note`); there is no separate violation channel.

If a gate throws, the report fails with a single check noting the exception.

## Six builtins

| Gate | Evidence |
|---|---|
| `artifacts_exist` | Each path in `envelope.artifacts` exists under the worktree (size on success). Empty list → one "nothing to verify" check. |
| `files_non_empty` | Declared artifact files have non-zero size; directories count as ok. Missing paths skipped here (use `artifacts_exist`). |
| `json_parses` | Declared `*.json` artifacts that exist parse as JSON. |
| `diff_matches_claims` | `changed_files` exist; unclaimed paths from git status since phase start fail. Empty claims require zero git changes. |
| `verdict_consistent` | Review cannot set `approved=true` with blocking items or unmet findings; rejection must name a problem. |
| `command_passes` | Configured `config.argv` exits 0 in the worktree (600s timeout). Missing argv fails. |

`GATE_DESCRIPTIONS` holds the one-line UI copy for each name.

## Unknown gates fail

If `GATES[spec.gate]` is missing, the report is:

```
passed: false
checks: [{ item: gateName, ok: false, note: 'unknown gate: nothing verified it' }]
```

Unknown names never skip silently. Designers must use a registered gate.

## Context gates see

```ts
interface GateContext {
  cwd: string;           // worktree, not base checkout
  changedPaths: string[]; // git changes since phase start
}
```

Gates resolve relative artifact paths against `cwd`. They check what is mechanically checkable; plan *quality* is a reviewer's job, not a gate's.

## Corrections

Failed checks become a correction message into the **same** agent session (`gateCorrection`). Envelope parse retries and gate retries use separate budgets from app settings (`envelopeRetries`, `gateRetries`).

## Trace

`GateResultRow` stores `gate`, `passed`, `checks`, `attempt`, and phase linkage. The UI can show exactly which items failed and why.

## Related

- [Envelope](envelope.md)
- [Phase](phase.md)
- [Pipeline](pipeline.md)
- [Envelopes and gates](../features/envelopes-and-gates.md)
- [Engine](../systems/engine.md)
