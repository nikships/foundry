---
name: foundry-e2e
description: Use when explicitly asked to E2E-test Foundry's effectiveness with a real model — prompt the Orchestrator, grade its plan, and if the plan is good run the pipeline to completion and grade the result. Spends real tokens; never invoke as routine change validation (that is foundry-ui).
---

# Foundry E2E: test Foundry like an operator would

Two-stage evaluation of Foundry's core value: **can it turn a prompt into a
good pipeline, and can that pipeline produce correct code?**

- **Stage 1** — prompt the Orchestrator, grade the plan it proposes. A bad
  plan is discarded and the session ends there.
- **Stage 2** — a good plan is confirmed; the run executes E2E (or until
  failure) on real models while you follow it through the trace DB, then you
  grade the outcome against expectations you wrote down beforehand.

Everything is driven through the real app on the operator's **real state**
(real projects, real provider credentials; runs land in their history). The
`foundry-ui` skill is the driving substrate — read it first for launch,
testids, and the eval-over-click discipline. This skill adds only what
`foundry-ui` forbids: actually starting a run.

## Hard rules

- **Only run when explicitly asked.** A session costs real tokens (typically
  hundreds of thousands to millions). One run per session unless the user
  asks for more.
- **Never** click `outcome-merge`, `outcome-discard`, PR actions
  (`outcome-open-pr`, `pr-create`, `prs-merge-*`), `Remove project`, or
  anything `foundry-ui` marks as a native-dialog trap.
- **Never clean up.** The worktree and `foundry/<runId>` branch are always
  kept; the report states their paths and the operator disposes of them.
- **Never kill the packaged Foundry.app**, never edit app-support JSON while
  the app runs, never write to the trace DB (the harness opens it readonly).

## Preconditions

1. Packaged Foundry.app closed (single-instance lock):
   `pgrep -fli "/Applications/Foundry.app"` must be empty. If it is running,
   stop and ask the user to quit it — do not kill it.
2. Fresh build if sources changed: `[ -d out/main ] || npm run build`.
3. Launch on the real user-data-dir with CDP, per `foundry-ui`:

   ```bash
   ./node_modules/.bin/electron . --remote-debugging-port=9250 > /tmp/electron.log 2>&1 &
   sleep 4 && curl -s http://127.0.0.1:9250/json/version
   agent-browser connect 9250
   ```

4. Pick the target project (any loaded project works) via
   `project-selector`, and note its **path** — the harness resolves the trace
   DB from it. Projects live in
   `~/Library/Application Support/foundry/foundry/projects.json`.

## Stage 0 — Compose the test prompt and pre-register expectations

Invent one realistic, bounded task for the chosen project: a small feature or
fix with a verifiable success condition. Inspect the repo enough to know the
task is real (not already done, not impossible).

**Before prompting Foundry**, write down in your report draft:

- the exact prompt you will submit;
- which files you expect a correct implementation to touch;
- what proof should exist (which project commands should pass, what behavior
  should change).

This pre-registration is what makes Stage-2 grading honest instead of
post-hoc rationalization.

## Stage 1 — Orchestrator plan, graded as a gate

1. On Runs (⌘1), fill `run-request` with the prompt and make sure the
   **Orchestrator** path is selected (the `OrchestratorPicker`, not a fixed
   pipeline), then start planning. Planning takes minutes; the proposal
   arrives as `data-testid="plan-card"`.
2. Poll for the card with `eval` (do not `wait --text`):
   `document.querySelector('[data-testid="plan-card"]') !== null`.
3. Read the plan from the card: `plan-refined-request`, the phase list with
   `plan-model-{phase}`, and `plan-warnings`.
4. **Grade it — your judgment, guided by these lenses** (not a scored
   rubric):
   - Did `refinedRequest` keep every constraint the prompt stated, without
     inventing scope?
   - Is the phase shape sensible — code phases followed by proof (project
     commands), reviewer phases carrying halting gates, feedback routed to
     the phase that owns the fix?
   - Is model casting economical — strong models on design/review/hard
     implementation, cheap fast ones on mechanical work?
   - Are synthesized agents' write boundaries tight?
   - Any `plan-warnings`? A plan containing an engineer checkpoint is an
     automatic rejection (the feature is being removed, FOU-191).
5. **Bad plan** → click `plan-discard`, write the report with verdict
   `plan-rejected` and your reasons, **stop**. Do not regenerate to fish for
   a passing plan — a rejected first proposal is itself the finding.
6. **Good plan** → record your plan assessment, then click `plan-start`.

## Stage 2 — Watch the run, then grade the result

### Watching

The trace DB is the progress channel — do not snapshot-poll the UI. Start the
tailer as a background process:

```bash
node .factory/skills/foundry-e2e/watch-run.mjs tail <project-path> > /tmp/foundry-e2e/tail.ndjson 2>&1 &
```

It resolves the newest running run, prints a `watching` line with the
`run_*` id, then one NDJSON line per phase transition, gate result, envelope,
and status change. Check on it every few minutes with
`tail -5 /tmp/foundry-e2e/tail.ndjson`. Spot-checking the Inspector (⌘2) is
fine; snapshot loops are not.

Exit codes:

- **0** — run reached a terminal status (`accepted` / `rejected` / `failed` /
  `killed`); the last line is `kind:"terminal"` with `outcome_detail`.
- **3** — **stall**: no trace activity for `--stall-min` minutes (default 10)
  while the run still claims to be running. This is a signal, not a verdict:
  check whether a phase is legitimately slow (a long test suite, a deep
  reasoning turn). If plausible, re-start the tailer with a higher
  `--stall-min`. If genuinely wedged, kill the run **through the UI**
  (`run-kill` → `confirm-accept`) and record it as a defect finding with
  verdict `killed-stalled`.

There are no engineer checkpoints mid-run (Stage 1 rejects plans that
contain one).

### Grading

1. Generate the dossier:

   ```bash
   node .factory/skills/foundry-e2e/watch-run.mjs report <project-path> --run <runId>
   ```

   It writes `/tmp/foundry-e2e/<runId>.md`: metadata, refined request, phase
   table with per-agent models, gate results, every envelope payload, tokens,
   and the worktree diff against the branch point.

2. Grade against your Stage-0 pre-registration:
   - Did the run reach its acceptance condition?
   - Does the **diff actually implement the expected shape** — right files,
     right behavior, nothing beyond scope?
   - Do gate results and envelope verdicts cohere with the diff, or did a
     reviewer wave through something the diff contradicts?
   - Objective check: run the project's own proof commands **inside the
     worktree** (`.foundry-worktrees/<runId>` under the project path) —
     read-only execution there is fine; never commit, merge, or push from it.
   - For a failed run: is the failure Foundry's (sequencing, gates, worktree,
     UI) or the model's (bad code that gates correctly caught)? A gate
     correctly stopping bad work is Foundry **succeeding**.

## Report

One Markdown file per session at `/tmp/foundry-e2e/<runId>.md` (append your
grading sections to the generated dossier; for a Stage-1 rejection with no
run, write `/tmp/foundry-e2e/<planTimestamp>-plan-rejected.md`). Sections:

1. **Test prompt + pre-registered expectations** (verbatim from Stage 0).
2. **Stage-1 plan verdict** and reasoning — always present.
3. **Stage-2 dossier + verdict** — when a run happened; include token count
   and wall-clock duration as the cost note.
4. **Defect findings** — anything that looks like a Foundry bug rather than
   a model shortfall, separated clearly; this is the actionable output.
5. **Final verdict**, one of: `plan-rejected` / `accepted-clean` /
   `accepted-with-findings` / `run-failed` / `killed-stalled`.
6. **Leftovers**: worktree path and branch name for the operator to inspect
   and clean up.

Tell the user the report path and the one-line verdict when done.

## Harness reference

`watch-run.mjs` (this directory) is read-only over the per-project
`trace.db` (WAL allows concurrent reads while the app writes). It loads
`better-sqlite3` from the repo's `node_modules`, so run it with the repo as
cwd. `<project>` accepts a project path, id, or name from `projects.json`.

```bash
node .factory/skills/foundry-e2e/watch-run.mjs tail <project> [--run <runId>] [--stall-min 10] [--interval 2]
node .factory/skills/foundry-e2e/watch-run.mjs report <project> --run <runId> [--out <file>]
```

If `better-sqlite3` fails to load under plain `node` (ABI mismatch after an
Electron bump), rebuild it for Node or read the DB with the system `sqlite3`
CLI as a fallback; do not switch the app itself to a different binary.
