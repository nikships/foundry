# AGENTS.md — src/main/readiness

Bespoke Agent Readiness Check. This is project onboarding, not a pipeline phase
and not a run: there is no tracer row, no `foundry/<runId>` branch, and no
zero-interrupt policy.

## Project Overview

- `marker.ts` — parse/validate/write `.agents/agent-ready.json`.
- `evaluate.ts` — language/monorepo-aware static checklist (no model).
- `session.ts` / `sessions.ts` — onboarding state machine + live registry.
- `worktree.ts` — isolated `foundry-ready/<id>` worktree via `engine/git.ts`.
- `merge.ts` — PR merge polling through the operator's `gh`.
- `ask-user.ts` — parks `droid.ask_user` for a real UI; pipeline policy is untouched.
- `prompt.ts` / `remediator.ts` — "Make it ready" agent turn.

## Invariants

- The marker file is truth. `ProjectDef.readinessValidated` is a cache.
- Marker is written last, after verification, then the PR is opened.
- AskUser exemption is scoped to readiness sessions. `permissions.evaluate`
  still auto-answers pipeline runs.
- Do not write SQLite. Do not call the run executor.
