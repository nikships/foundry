# AGENTS.md — src/main/readiness

Agent Readiness is project onboarding, not a pipeline run. It has no trace row, run branch, or zero-interrupt policy. Smith’s readiness tools are the UI entry point; resumable state lives outside chat so “New chat” cannot lose partial work.

## Ownership

- `marker.ts` parses and writes `.agents/agent-ready.json`.
- `evaluate.ts` performs the static checklist.
- `session.ts` / `sessions.ts` own onboarding state and resumability using shared panel infrastructure.
- `worktree.ts` owns isolated `foundry-ready/<id>` worktrees.
- `merge.ts` polls PR merge state through the operator’s `gh`.
- `prompt.ts` / `remediator.ts` own the repair turn.

## Invariants

- **The marker on the project’s base ref is truth.** `ProjectDef.readinessValidated` is only a cache. Fall back to the checkout only if the base ref cannot resolve, and say so.
- **A merged PR is not proof.** Finalization re-reads the base ref and persists readiness only when a valid marker exists.
- Write and force-add the marker only after verification, then open the PR.
- Preserve recoverable `foundry-ready/<id>` worktrees. Failures and paused cancellation become `needs_continue`; only “Start over” discards work.
- Continue resumes the last durable step instead of restarting the flow.
- Remediation stays in its readiness worktree even though ordinary Smith edits target the checkout.
- Do not write SQLite or call the run executor.
