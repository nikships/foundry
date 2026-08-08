# AGENTS.md — src/main/engine

Deterministic runner. Code owns sequencing/retries/acceptance; agents work
inside one phase and never decide if they succeeded.

## Invariants

- A phase is born `fail`. Corrections re-prompt the **same live session**
  (one message, not a cold restart); envelope and gate retries have separate
  budgets.
- Envelopes are typed seams (`envelopes.ts`): the JSON example shown to the
  agent is derived from the same zod schema the answer is parsed against —
  don't hand-write examples or parse outside the schema.
- Gates return evidence, not verdicts — one `GateCheck` per item examined
  (`gates.ts`). Unknown gate names fail.
- Write boundaries are enforced after the call by diffing `git status`
  (`boundary.ts`): `null` = unrestricted minus protected, `[]` = read-only,
  list = allowlist (`*` within segment, `**` across). Always-protected
  `.foundry/` `.git/` `.foundry-worktrees/` plus project `protectedPaths`.
  Violations are reverted and the phase fails.
- Every run gets a fresh `foundry/run_*` branch + worktree; merge/discard
  stays in `worktree.ts`. `git.ts` porcelain parser ignores git's stderr chatter.
- New `PhaseKind` or gate: add to `src/shared/types.ts`, wire runner/registry,
  add a test against real git temp repos (see `tests/executor.test.ts`).
