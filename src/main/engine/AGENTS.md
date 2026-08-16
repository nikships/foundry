# AGENTS.md — src/main/engine

Deterministic runner that owns phase sequencing, retries, write boundaries, gates, acceptance, and per-run worktrees. Agents never decide whether a phase or run succeeded — code does.

## Project Overview

- Phases: `agent` (LLM via Droid transport), `code` (shell `CommandSpec`), `engineer` (code + gates). Registry owns phase/gate definitions; `executor.ts` + `runners/*` drive execution.
- Worktree: `.foundry-worktrees/<runId>` on `foundry/<runId>`; `.foundry-handoff/` JSON files pass envelopes between phases. `worktree.ts` owns create/merge/discard.
- Envelopes: Zod schemas in `envelopes.ts`; `jsonSchemaFor()` exposes defaults as required and emits no `$schema` dialect (Droid compiles Draft‑07). Example, output constraint, and parser come from the same definition.
- Gates: return evidence (`GateCheck`), not a verdict; unknown gate → fail (`gates.ts`).
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
4. Add a real-git executor test in `tests/executor.test.ts`.

Other references: `cli/` owns vendor argv, `droid/` owns transport, `store/pipelines.ts:dryRun()` renders prompts without spending a run.

## Testing Instructions

```bash
npm test
npx vitest run -t "executor|envelope|gate|boundary|preflight|worktree"
npx vitest run tests/executor.test.ts
npx vitest run tests/envelopes.test.ts
npx vitest run tests/gates.test.ts
```

- Use **real git temp repos** + `tests/scripted-agent.ts`, an in-memory daemon whose scripted turns perform real disk side effects inside the worktree, so boundary checks are real. Do NOT mock git or use network/model.
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
- **Rewind** (SDK) happens only on the configured correction number, restores files from the phase-start snapshot, and falls back to append-style correction on failure. One-shot sessions never rewind.
- **Kill outranks acceptance.** Once cancellation fires, stop recovery and settle `killed`; do not let a protocol fallback complete the run.
- **Setup script** (`setupScript` via `sh -c` at worktree root) runs before agent phases; failure keeps the worktree for inspection. A `scaffold` project treats a missing referenced code command as a warning and skips that code phase.

## Code Style

- Keep vendor argv parsing in `cli/`, transport work in `droid/` — not here.
- Gate and envelope modules export plain values/types consumable from tests; avoid coupling them to `AppContext`.
- No `eslint-disable`; address real issues. Use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
npm run check  # full gate
```

No engine-specific build step; it bundles as part of `out/main/main.js`.

## Additional Notes

- **Command detection is separate from runs:** manifest sniffing is free, but `DetectSession` always asks an agent and runs against the base checkout with `DETECT_TOOLS` read-only restrictions. Detection has no worktree/trace rows/cursor; its progress is pushed via `detection-progress`.
- **Acceptance** lives in `acceptance.ts` (post-phase checks beyond per-phase gates).
- **Preflight** (`preflight.ts`) validates the run can start before touching git.
