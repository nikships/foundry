# AGENTS.md — src/main/engine

The engine deterministically owns phase sequencing, retries, boundaries, gates, healing, acceptance, worktrees, and settlement. Agents never decide whether a phase or run succeeded.

## Structure

- `executor.ts` and `runners/` drive `agent` and `code` phases.
- `worktree.ts` creates, merges, and discards `.foundry-worktrees/<runId>`.
- `settle.ts` owns landing and repair so IPC remains logic-free.
- `base-sync.ts` inspects and fast-forwards the local base ref, ff-only.
- `envelopes.ts`, `gates.ts`, and `registry.ts` define phase protocols.
- `rewinder.ts` owns correction rollback.
- `healing.ts` runs bounded repair turns for eligible code phases.
- `phase-context.ts` and `prompts.ts` render phase inputs.
- `compaction.ts` owns the Foundry compact summary and constitution pins.

New phase kinds or gates require shared types, registry/schema/check wiring, runner/prompt support, and a real-Git executor test.

## Invariants

- **A phase starts failed.** It succeeds only after clean exit, valid envelope, and passing gates. Envelope correction and gate feedback have separate budgets.
- **Envelope parsing and validation share one budget.** Structured output remains a candidate until domain validation passes.
- **Boundaries are enforced after each call with `git diff`.** `null` permits writes except protected paths; `[]` is read-only; allowlists support `*` and `**`. Revert violations and fail the phase.
- **Compaction occurs only between phases.** Foundry supplies the summary
  (request, current phase, artifacts, open failures, files, envelope fields)
  and pins the phase prompt and project card. Pi auto-compaction stays off.
  The prompt ledger is forgotten only after a compact that actually dropped
  messages, and then only for phases other than the pin.
- **Rewind is coordinated.** `PhaseRewinder` rewinds transport before the phase prompt and restores the worktree to the phase-start snapshot. On failure, correction falls back to append-only behavior.
- **Commands are frozen.** A `{ref}` command changes only when a fresh sniff proves run-scoped drift. Persist drift to project settings only after successful landing.
- **Settlement goes through `settle.ts`.** `recordLanding` alone marks a run merged; preserve branch-point, worktree-clear, drift, and notification ordering.
- **Cancellation outranks acceptance.** Once killed, stop recovery and settle killed.
- **Setup runs at the worktree root before phases.** A non-zero setup exit fails the run before phase 1 (scaffold excepted). Do not re-run setup on continue when the worktree still exists. Keep failed worktrees for inspection. Scaffold projects may skip a missing referenced code command.
- After `git worktree add`, if `.gitmodules` exists, initialize submodules inside the run worktree (`git submodule update --init --recursive`). Fail closed if init fails. Never write the operator's primary checkout.
- **Healing does not judge itself.** `{ref}` proof phases re-run without edits (default 2) before a healer may write; a pass with no healer is a flake (`heal_class`). Then re-run the exact frozen command after each bounded repair attempt. Exhaustion reverts in-phase edits (not earlier phases) and falls through to existing feedback or run failure.
- Healing uses normal boundary checks, never handles optional/skipped/setup failures, and keeps one budget per phase per run across feedback re-entry.
- **Model-blocking work registers a cancellation interrupt** and releases it when complete. A cancellation that arrived first must abort immediately.

Detection and setup are not runs. They use shared panel sessions, have no worktree or trace rows, and push progress separately.

## Tests

Use real Git repositories and scripted transports. Never mock Git or call a model.

```bash
npx vitest run apps/desktop/tests/main/engine/executor.test.ts
npx vitest run -t "envelope|gate|boundary|rewinder|healing|settle|base-sync"
```
