# AGENTS.md — src/main/engine

Deterministic runner that owns phase sequencing, retries, write boundaries, gates, acceptance, and per-run worktrees. Agents never decide whether a phase or run succeeded — code does.

## Project Overview

- Phases: `agent` (LLM through the `pi/` agent transport), `code` (shell `CommandSpec`), `engineer` (code + gates). Registry owns phase/gate definitions; `executor.ts` + `runners/*` drive execution. `rewinder.ts` (`PhaseRewinder`) owns correction rollback for an agent phase.
- Worktree: `.foundry-worktrees/<runId>` on `foundry/<runId>`; `.foundry-handoff/` JSON files pass envelopes between phases. `worktree.ts` owns create/merge/discard. `settle.ts` owns landing a finished run (`landRun` / `repairBranch`) so the IPC routers stay logic-free. `base-sync.ts` inspects and fast-forwards the project's local base ref against the preferred remote so a run does not start from a stale `main`; inspect never moves a local branch, and sync is ff-only.
- Envelopes: Zod schemas in `envelopes.ts`; `jsonSchemaFor()` exposes defaults as required and emits no `$schema` dialect (pi compiles the schema itself and does not want a dialect declared). Example, output constraint, and parser come from the same definition.
- Gates: return evidence (`GateCheck`), not a verdict; unknown gate → fail (`gates.ts`).
- Healing (`healing.ts`): a failed code phase gets a bounded write-capable one-shot in the run's worktree before the failure escalates. The command stays frozen and is re-run after every attempt; only exit 0 counts. Eligibility is `healingEligible` in `shared/types.ts` so the Designer's toggle and the engine agree: on for every non-`optional` code phase unless `heal: false`. It deliberately does not depend on the command's source — a repo with a pre-commit hook makes `git_commit` a quality gate, so a commit failure is usually the most repairable one there is.
- Context: `phase-context.ts` / `prompts.ts` render prompts from templates + `request` / `envelope:<phase>` / `handoff_files` / `feedback`.

## Setup Commands

```bash
npm ci
npm run dev        # run the app and exercise the engine via the UI
npm run test       # or run engine suites directly (see below)
```

No standalone engine setup — it runs inside the Electron main process.

## Development Workflow

Typical change flow for a new phase kind or gate:

1. Add types to `src/shared/types.ts` (`PhaseKind`, `GateSpec`, `EnvelopeKind`).
2. Register schemas/checks in `envelopes.ts` / `gates.ts` / `registry.ts`.
3. Wire runners in `runners/` and prompt rendering in `prompts.ts`.
4. Add a real-git executor test in `apps/desktop/tests/main/engine/executor.test.ts`.

Other references: `pi/` owns every agent call (the transport a phase runs on and the one-shot detection, setup, and repair use), `store/pipelines.ts:dryRun()` renders prompts without spending a run.

## Testing Instructions

```bash
npm test
npx vitest run -t "executor|envelope|gate|boundary|rewinder|preflight|worktree|settle"
npx vitest run apps/desktop/tests/main/engine/executor.test.ts
npx vitest run apps/desktop/tests/main/engine/rewinder.test.ts
npx vitest run apps/desktop/tests/main/engine/envelopes.test.ts
npx vitest run apps/desktop/tests/main/engine/gates.test.ts
npx vitest run apps/desktop/tests/main/session/panel-session.test.ts
npx vitest run apps/desktop/tests/main/engine/detect-session.test.ts
npx vitest run apps/desktop/tests/main/engine/setup-session.test.ts
npx vitest run apps/desktop/tests/main/engine/healing.test.ts
npx vitest run apps/desktop/tests/main/engine/settle.test.ts
npx vitest run apps/desktop/tests/main/engine/base-sync.test.ts
```

- Use **real git temp repos** + `apps/desktop/tests/helpers/scripted-transport.ts`, an in-memory `AgentTransport` whose scripted turns perform real disk side effects inside the worktree, so boundary checks are real. Do NOT mock git or use network/model.
- Compaction, rewind, and boundary tests need snapshot/restore of the worktree to be realistic.

## Invariants

- **Starts `fail`, succeeds only after** clean exit, parsed envelope, and green gates. Corrections re-prompt the same live session; **envelope and gate budgets are separate** retry counters.
- **Envelope parser/validator share one budget.** Structured output is a candidate; `validateEnvelope` and text parsing share that budget. `jsonSchemaFor` rules apply.
- **Boundary enforcement is post-call `git diff`.**
  - `null` = unrestricted except protected paths (always denied)
  - `[]` = read-only
  - list = allowlist with segment `*` and recursive `**` matching
  - Violations are reverted and the phase fails. Permission evaluation is NOT the enforcement mechanism.
- **Compaction between phases only**, never while a stream is open.
- **Rewind** is owned by `PhaseRewinder` (`rewinder.ts`), constructed with the worktree and session. It happens only on the configured correction number and falls back to append-style correction on failure. One-shot sessions never rewind. After a successful transport rewind, `restoreToPhaseStart` checks out clean-at-start tracked deletions from `snapshot.headSha` and reverts new untracked files, then the baseline is re-snapshotted and the phase anchor re-pinned. The transport only restores files that were already dirty at phase start; Foundry owns the rest. The agent runner only calls `rewindIfDue` before a retry turn.
- **`{ref}` commands stay frozen unless the worktree sniff disagrees.** `resolveRefCommand` re-sniffs before the code phase. Matching or missing sniff keeps the project argv. A different sniff winner is run-scoped drift (`command-drift.json`); `landRun` applies it to project settings after `merged=true`, whether the landing was a local merge or a GitHub merge. Agents never choose argv.
- **Settlement invariants live in `settle.ts`.** `recordLanding` is the one place a run becomes merged — operator `landRun` and the executor's auto-merge both go through it. `setBranchPoint` before a post-repair merge, `setWorktree(null)` after discard, drift only after `merged=true`, `notifyRuns` after every tracer write. The executor still fire-and-forgets `worktree.settle` so `finish()` can return `accepted (merging)` without waiting.
- **Kill outranks acceptance.** Once cancellation fires, stop recovery and settle `killed`; do not let a protocol fallback complete the run.
- **Setup script** (`setupScript` via `sh -c` at worktree root) runs before agent phases; failure keeps the worktree for inspection. A `scaffold` project treats a missing referenced code command as a warning and skips that code phase.
- **Healing never decides its own success, and never replaces escalation.** A healer gets `FIXED_ENGINE_DEFAULTS.healingAttempts` turns **per phase per run** (a `feedbackTo` re-entry resumes the same budget rather than being handed a fresh one), each judged by re-running the phase's exact argv; boundary enforcement is the same post-turn `git diff` an agent phase gets, with `writes: null` so only protected paths are denied. Exhaustion falls through to the existing `feedbackTo` budget (or fails the run) — it does not add a loop. Optional failures, missing/unconfigured commands, scaffold skips, and setup failures never heal: they are answered before or above the healer. A run with no configured healing behaves exactly as it did before healing existed.
- **Anything that blocks a phase on a model must register an interrupt.** `cancelled()` is only honest between awaits, so a turn already in flight would otherwise run to its own timeout while the operator waits. An agent phase is safe because `cancel()` kills its session; everything else (healing today) takes `RunContext.onCancel` and releases it when the work completes. A cancel that lands first fires the abort immediately, so registering after the fact is not a hole.

## Code Style

- Keep session work in `pi/` (the transport) and `session/` (the live panel). `detect-session.ts` and `setup-session.ts` are thin ask-and-parse strategies on `PanelSession`; they take an `OneShotFactory` rather than building one, which is what lets a test drive them without a model. Repair does the same.
- Gate, envelope, and settlement modules export plain values/types consumable from tests; avoid coupling them to `AppContext`. `settle.ts` takes `SettleHooks` so notify/save/one-shot are injected.
- No `eslint-disable`; address real issues. Use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
npm run check  # full gate
```

No engine-specific build step; it bundles as part of `out/main/main.js`.

## Additional Notes

- **Command detection is separate from runs:** manifest sniffing is free, but `DetectSession` always asks an agent and opens the base checkout with read-only access. Detection has no worktree/trace rows/cursor; its progress is pushed via `detection-progress`. A later `{ref}` phase may re-sniff the worktree only to detect that the frozen argv is stale.
- **Acceptance** lives in `acceptance.ts` (post-phase checks beyond per-phase gates).
- **Preflight** (`preflight.ts`) validates the run can start before touching git.
