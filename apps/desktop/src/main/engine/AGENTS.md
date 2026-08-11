# src/main/engine

The deterministic runner owns phase sequencing, retries, write boundaries,
gates, acceptance, and per-run worktrees. Agents never decide whether a phase
or run succeeded.

## Invariants

- A phase starts `fail` and becomes `success` only after clean exit, parsed
  envelope, and green gates. Corrections re-prompt the same live session;
  envelope and gate budgets are separate.
- The envelope example, output constraint, and parser must come from the same
  zod definition. `jsonSchemaFor` exposes defaulted fields as required and
  emits no `$schema` dialect (Droid compiles Draft-07). Structured output is a
  candidate; `validateEnvelope` and text parsing share the envelope retry
  budget.
- Gates return evidence (`GateCheck`), not a verdict. Unknown gates fail.
- Boundary enforcement is post-call git diffing: `null` means unrestricted
  except protected paths, `[]` is read-only, and a list is an allowlist with
  segment `*` and recursive `**` matching. Violations are reverted and fail
  the phase; permission evaluation is not the boundary enforcement mechanism.
- Compaction happens between phases, never while a stream is open. SDK rewind
  happens only on the configured correction number, restores files from the
  phase-start snapshot, and falls back to append-style correction on failure.
  One-shot sessions never rewind.
- A kill outranks acceptance. Once cancellation fires, recovery is stopped and
  the run settles `killed`; do not let a protocol fallback complete it.

## Worktrees and phase context

A run creates `.foundry-worktrees/<runId>` on `foundry/<runId>` and creates
`.foundry-handoff/` in that worktree. Earlier phase handoff JSON files are
listed in later prompts. Before agent phases, an optional project
`setupScript` runs as `sh -c` at the worktree root and failure keeps the
worktree for inspection. A `scaffold` project treats a missing referenced code
command as a warning and skips that code phase.

Command detection is separate from runs: manifest sniffing is free, but
`DetectSession` always asks an agent and runs against the base checkout with
`DETECT_TOOLS` read-only restrictions. Detection has no worktree, trace rows,
or cursor; its progress is pushed.

Add a new phase kind or gate to shared types, runner/registry wiring, and a
real-git executor test. Keep vendor argv parsing in `cli/` and transport work
in `droid/`.
