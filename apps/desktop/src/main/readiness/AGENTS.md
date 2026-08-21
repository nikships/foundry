# AGENTS.md — src/main/readiness

Bespoke Agent Readiness Check. This is project onboarding, not a pipeline phase
and not a run: there is no tracer row, no `foundry/<runId>` branch, and no
zero-interrupt policy.

The operator-facing surface is Smith. The chat's `readiness_check`,
`readiness_remediate`, and `readiness_pr_status` tools wrap the machinery in
this directory; there is no readiness modal and no parked ask-user channel.
`needs_continue` still lives here, outside the chat session, so "New chat"
never loses a half-done onboarding.

## Project Overview

- `marker.ts` — parse/validate/write `.agents/agent-ready.json`.
- `evaluate.ts` — language/monorepo-aware static checklist (no model).
- `session.ts` / `sessions.ts` — onboarding state machine + live registry. The transcript ring, cancel, and snapshot clone come from `session/PanelSession`; sweep/keep-limits come from `SessionRegistry`. Git/worktree/PR stay here.
- `worktree.ts` — isolated `foundry-ready/<id>` worktree via `engine/git.ts`.
- `merge.ts` — PR merge polling through the operator's `gh`.
- `prompt.ts` / `remediator.ts` — "Make it ready" agent turn.

Smith's readiness tools (`src/main/smith/readiness-tools.ts`) are the only
caller that starts or continues this session from the UI.

## Invariants

- **The marker on the project's base ref is truth.** Run worktrees branch from
  that ref, so a marker present only in the operator's checkout proves nothing.
  `readMarkerAtBaseRef()` is the single reader; `inspectProject()` (the Runs
  banner) and `ReadinessSession` finalization both go through it, so Smith and
  the Runs page cannot disagree. `ProjectDef.readinessValidated` is a cache
  and never outranks the file. Only when the base ref cannot be resolved at all
  does it fall back to the working checkout, and it says so in the detail.
- **A merged PR is not proof.** `finalize()` re-reads the base ref after the
  fast-forward and does not persist `readinessValidated: true` unless a valid
  marker is there. A miss parks on `needs_continue` so the operator can check
  again — it does not throw the session away.
- Marker is written last, after verification, then the PR is opened. It is
  force-added (`git add -f`) because repos commonly gitignore `.agents/`, which
  would otherwise drop the proof from the commit the PR carries.
- **A worktree is recoverable work.** `setPhase('failed')` converts to
  `needs_continue` while `foundry-ready/<id>` still exists. Connection errors,
  verify misses, gh failures, and a paused cancel all keep the branch.
  Continue resumes the last step on that branch (another remediator turn, open
  the PR again, or re-check the merge). Start over is the only path that
  discards it. `failed` means there is nothing left to resume.
- **Remediation stays on `foundry-ready/<id>`**, even though Smith itself edits
  the checkout directly. The deliverable is a reviewable PR; the proof is the
  marker on the base ref; a half-done onboarding must survive "New chat".
- Do not write SQLite. Do not call the run executor.
