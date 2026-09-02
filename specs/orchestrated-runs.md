# Orchestrated Runs — the prompt-first Runs screen

**Status:** approved direction, not yet implemented
**Date:** 2026-08-23

## One-liner

Replace "pick a pipeline, write a brief" with a single centered prompt. An
**Orchestrator** — a setup-and-judgment agent — reads the request and the
project, then composes a run-specific pipeline on the fly from everything
Foundry has: roster agents, synthesized one-off agents, project commands,
builtin gates, envelopes, engineer checkpoints, healing, and feedback loops.
The operator confirms the plan with one click; the engine executes it exactly
as it executes a hand-built pipeline. When something fails past its budgets,
the Orchestrator can amend the remaining pipeline mid-run without asking.

## Decisions locked in

| Question | Decision |
| --- | --- |
| Plan trust | Always one-click confirm before the run starts. Never auto-start. |
| Building blocks | Everything: existing roster agents, synthesized per-run agents, project commands, builtin commands, all gates, engineer checkpoints, custom envelopes, `feedbackTo`, healing. |
| Mid-run adaptivity | Orchestrator may re-plan/extend the pipeline on failure. No second confirm. Bounded by a fixed engine budget (see Invariants). |
| Persistence | Generated pipelines are ephemeral, recorded on the run. Export affordance at run end (and retroactively from the run detail): save the pipeline, save any synthesized agents — individually or all at once. |
| Orchestrator model | Chosen on the Runs screen itself, beside the prompt. Model + reasoning effort, softly persisted (localStorage), no new `AppSettings` field. |
| Manual mode | Orchestrator is the default. A toggle reveals the classic pipeline picker + brief flow, fully functional. Existing pipelines keep living in the Designer. |

## Naming

The feature is **the Orchestrator**; the run mode is an **orchestrated run**.
On screen the picker reads as a small ceremony, e.g.:

> **THE ORCHESTRATOR** — *every run answers to one mind*
> `[ claude-opus-4 ▾ ] [ high ▾ ]`

(Exact copy is a design pass; keep the "appoint the one in charge" register,
not a settings-form register.)

---

## 1. UX

### 1.1 Runs screen (orchestrated mode, default)

ChatGPT/Gemini-home layout:

- Vertically centered hero: a large prompt box (`textarea`, autosizing),
  placeholder like *"What should the factory build?"*. `⌘↵` submits.
  Pasting PNG/JPEG/WebP/GIF images attaches compact removable chips; text in
  the same paste still inserts as text. Image-only submits are allowed; empty
  text with no images still blocks with "Describe what to build".
- Directly beneath/beside it, the Orchestrator picker: model dropdown +
  reasoning dropdown, drawn from pi's catalog exactly like Smith's header
  picker. Both persist to `localStorage` (`foundry.orchestrator.model`,
  `foundry.orchestrator.reasoning`); default is `inherit` → app default model.
- A quiet toggle (e.g. "Manual pipeline…" link or segmented control) switches
  to the classic composer: pipeline dropdown + ribbon + Start. The choice
  persists (`foundry.runs.mode`).
- Run history collapses to a compact list below the fold (scroll to reach it),
  reusing today's run rows. Readiness banner and `BaseSyncBar` stay, restyled
  as slim strips above the hero — both still gate starting.
- No-project state keeps today's EmptyState.

### 1.2 Planning state

Submitting the prompt does not start a run. It opens a **planning session**:

- The hero collapses upward; a live planning panel streams the Orchestrator's
  progress (same `PanelEntry` transcript treatment detection/setup use, pushed
  over a new `orchestrator-progress` channel).
- Output is a **Plan card**: refined request (the Orchestrator always rewrites
  the prompt into a full brief), ordered phase list (reusing
  `PipelineRibbon` / phase-card visuals from the Designer), each synthesized
  agent with purpose/model/boundary, the acceptance rule, and a short
  rationale ("why this shape").
- Actions: **Start run** (primary, one click), **Regenerate** (optionally with
  an edited prompt — the textarea stays editable), **Discard**.
- Validation errors from the store rails or preflight refuse the card and are
  fed back to the Orchestrator automatically (bounded correction retries,
  reusing the envelope-correction pattern); only a valid plan ever renders.

### 1.3 During the run

- The run opens in the existing Run detail / Inspector unchanged. The
  generated pipeline renders exactly like a stored one (phase rows come from
  the trace, which is already pipeline-agnostic).
- A mid-run amendment appears in the transcript as a `replan` event with the
  evidence and the inserted/replaced phases; new phase rows appear queued.
  A subtle badge on the run ("amended ×2") signals the pipeline evolved.

### 1.4 After the run

- Run detail (and the finish banner) offers **Export…**: a sheet listing the
  generated pipeline and every synthesized agent with checkboxes, plus
  "Save all". Saving routes through the existing pipeline/roster stores with
  normal name-collision validation. Exported entities lose any run-specific
  ids and become ordinary editable entities.

---

## 2. Architecture

### 2.1 New shared types (`src/shared/types.ts`)

```ts
/** What the Orchestrator hands back for confirmation. */
export interface GeneratedRunPlan {
  planId: string;
  projectId: string;
  /** The operator's raw prompt, kept verbatim for the trace. */
  prompt: string;
  /** The Orchestrator's rewritten full brief; becomes the run `request`. */
  refinedRequest: string;
  /** Why the pipeline has this shape, operator-facing. */
  rationale: string;
  pipeline: PipelineDef;          // id: `generated:<planId>`, builtin: false
  /** Synthesized agents referenced by the pipeline but absent from the roster. */
  agents: AgentDef[];
  /** Non-blocking warnings from validation/preflight, shown on the card. */
  warnings: ValidationIssue[];
  model: string;
  reasoningEffort: ReasoningEffort;
}

/** One mid-run amendment: replaces the not-yet-run tail of the pipeline. */
export interface PipelineAmendment {
  reason: string;
  /** Phases replacing everything after the failed phase. May insert repair
   *  phases, re-order, or extend; completed phases are immutable history. */
  phases: PhaseDef[];
  /** Additional synthesized agents the new phases need. */
  agents: AgentDef[];
}
```

`StartRunInput` grows an optional `plan?: GeneratedRunPlan` (when present,
`pipelineId` is ignored). `RunRow` gains `orchestrated: boolean` and
`amendments: number` (denormalized for the list badge). New `EventType`
member: `'replan'`.

### 2.2 Orchestrator planning session (`src/main/orchestrator/`)

New main-process module, modeled on `DetectSession`:

- `plan-session.ts` — a `PanelSession` one-shot opened **read-only** at the
  project checkout (same access shape as detection), on the operator-chosen
  model/reasoning. No worktree, no trace rows; progress pushes over
  `orchestrator-progress`.
- **Prompt inputs:** the raw request, the project's `contextSummary`, the
  project commands (names + argv), the full roster (name/purpose/envelope/
  boundary — not prompts, to keep context lean), the custom envelope library,
  the gate catalog with per-gate blurbs, the builtin pipeline shapes as
  few-shot examples, and the rules below. Optional in-memory images live only
  on the planning session deps and are forwarded on every ask, including
  correction retries. They never appear on `OrchestratorState` / progress.
- **Output:** strict JSON parsed with Zod (`GeneratedRunPlan` minus ids), same
  parse-or-correct loop as envelopes, `FIXED_ENGINE_DEFAULTS.envelopeRetries`
  budget.
- **Post-parse rails:** the plan is passed through `store/pipelines.ts`
  `validate()` and `engine/preflight.ts:preflightForRun()` with roster =
  project roster + synthesized agents. Errors go back to the session as a
  correction; a plan that cannot validate within budget fails the planning
  session (never reaches the card).
- **Composition rules given to the Orchestrator (also enforced where code
  can):** always refine the request first (its own phase or fold into the
  brief), every code-editing phase is followed by proof (`{ref: test}` /
  typecheck/lint refs that exist in project commands) before a commit,
  reviewer/verifier phases carry `verdict_consistent` + `disapproval_halts`,
  `feedbackTo` names the phase that owns the fix, acceptance is
  `envelope_status` on a final PR phase when gh is available, else
  `all_phases_pass`. Synthesized agents get tight `writes` boundaries and a
  one-line purpose; prefer roster agents when one fits.

### 2.3 Starting an orchestrated run

`startRun` in `engine/operations.ts` accepts the inline plan:

- Pipeline = `plan.pipeline`, agents = roster ∪ `plan.agents` (synthesized
  agents shadow nothing; a name collision is a validation error at plan time).
- `request` = `plan.refinedRequest` (the raw prompt is recorded on the run).
- Missing-command fill, preflight, and `registry.start` are unchanged —
  `registry.start` already takes `PipelineDef` + `AgentDef[]` inline, so the
  engine does not know the pipeline was generated.
- The tracer persists the full plan (pipeline JSON + synthesized agents +
  prompt + rationale) on the run — new `run_plan` column/table written only by
  `Tracer` — so retroactive export and the Inspector's pipeline view survive
  app restarts and never depend on the pipeline store.

### 2.4 Mid-run re-planning (`executor.ts` + `orchestrator/replan.ts`)

A new optional executor dep, mirroring how `healing` is injected:

```ts
replanner?: {
  propose(input: {
    plan: GeneratedRunPlan;
    failedPhase: PhaseDef;
    completed: { phase: PhaseDef; envelope?: Envelope }[];
    remaining: PhaseDef[];
    evidence: string;            // gate checks / command tail / reviewer verdict
    attempt: number;
  }): Promise<PipelineAmendment | null>;
}
```

- **Trigger:** only after every existing recovery is exhausted — corrections,
  gate retries, healing, and `feedbackTo` budgets. Re-planning is the layer
  above healing, exactly as healing is the layer above retries. It replaces
  the point where the run would settle `failed`/`rejected`.
- **Budget:** `FIXED_ENGINE_DEFAULTS.replanAttempts = 2` per run (fixed, not
  operator-configurable, same philosophy as healing). Exhaustion fails the run
  with today's semantics.
- **Application:** amendment replaces the queue *after* the failed phase
  (the failed phase itself may be re-included in the new tail). Completed
  phase rows are history and never rewritten. New/changed phases get fresh
  `PhaseRow`s; the amendment is traced as a `replan` event carrying reason +
  before/after phase names. Acceptance re-derives from the amended pipeline.
- **No confirm:** applied automatically. The Orchestrator session is a fresh
  read-only one-shot per amendment (opened in the **worktree**, so it sees the
  actual failing tree), on the same model the plan used.
- **Cancel:** the replan turn registers a `RunContext.onCancel` interrupt like
  healing does — kill outranks everything.
- Runs started manually (classic mode) never re-plan: `replanner` is only
  injected for orchestrated runs.

### 2.5 Verification-agent capability (note, not a blocker)

"Launch the app and check it visually" is expressible today only as an agent
phase whose tools run commands in the worktree. A first-class visual-verify
phase (managed app launch + screenshot harness) is out of scope; the
Orchestrator composes review/finisher-style agent phases with
`verdict_consistent`/`disapproval_halts` instead. Revisit as its own spec.

### 2.6 IPC surface (`ipc-contract.ts` → `ipc/` → `bridge.ts` → `api.ts`)

- `orchestrator:plan (projectId, prompt, model, reasoningEffort, images?) →
  { planId } | { error }` — kicks off the session; result + progress push over
  `orchestrator-progress` (keep `mockFoundry.ts` in sync). `images` is an
  optional list of `{ mediaType, data, name? }` (PNG/JPEG/WebP/GIF; at most 8;
  4 MB each; 12 MB total decoded). Companion HTTP `POST /v1/orchestrator/plans`
  stays text-only.
- `orchestrator:cancel (planId)`
- `runs:start` — existing channel, `StartRunInput` now carrying `plan?`.
- `runs:plan (runId) → GeneratedRunPlan | null` — for retroactive export view.
- `runs:exportPlan (runId, { pipeline: boolean; agents: string[] }) →
  { ok, issues }` — writes through the pipeline/roster stores.

### 2.7 Renderer

- `RunsScreen.tsx` is rebuilt around three states: **compose** (hero),
  **planning** (live panel), **plan-ready** (card). Manual mode renders the
  existing composer largely as-is (extract it to
  `components/run/ManualComposer.tsx`).
- New `components/run/OrchestratorPicker.tsx`, `PlanCard.tsx`,
  `ExportPlanSheet.tsx`; view-model `view-models/plan-view.ts` (pure,
  testable: card shaping, warning grouping, export selection).
- Run detail gains the amendment badge, the `replan` transcript entry
  (`inspector/entries.tsx` case — new events are silently dropped otherwise),
  and the Export sheet.

---

## 3. Invariants (extends engine AGENTS.md)

1. The Orchestrator **proposes; code disposes.** Plans and amendments pass the
   same `validate()` + preflight rails as hand-built pipelines. An invalid
   plan is corrected or refused, never partially applied.
2. A generated pipeline executes under the **unchanged engine contract**:
   phases start `fail`, boundaries diff git, gates return evidence, `finish()`
   settles once. The executor cannot tell generated from stored.
3. Re-planning **replaces failure, never success**: it fires only where the
   run would otherwise settle red, is budgeted by
   `FIXED_ENGINE_DEFAULTS.replanAttempts`, and never touches completed phases.
4. The persisted run plan is **the trace's property** (Tracer sole writer);
   export is a read of the trace plus normal store writes.
5. Synthesized agents exist **only inside the run** until exported; they never
   silently enter the roster.
6. Classic manual runs are byte-for-byte unaffected.

---

## 4. Delivery slices

1. **Plan → confirm → run (static):** shared types, orchestrator module,
   IPC, plan persistence in trace, minimal plan card on the current screen.
   Engine untouched beyond `startRun` accepting an inline plan.
2. **New Runs screen:** hero layout, Orchestrator picker + soft persistence,
   manual-mode toggle, planning panel, full Plan card.
3. **Mid-run re-planning:** executor `replanner` dep, `replan` event + phase
   append, budget, transcript entry, amendment badge.
4. **Export:** `runs:plan` / `runs:exportPlan`, Export sheet, finish-banner
   affordance.

Each slice lands with its tests: scripted-transport executor tests for 1 and 3
(real git repos; a scripted replan proposal), plan-session parse/validate
tests mirroring `detect-session.test.ts`, view-model unit tests for 2 and 4,
and an e2e extension seeding an orchestrated run for the Inspector smoke.

## 5. Open questions (deferred, not blockers)

- Companion parity: the phone can already start runs; orchestrated start from
  mobile reuses the same operations seam but the plan card UX is a follow-up.
- Should regenerate reuse the planning session (cheaper, remembers context) or
  open fresh? Start fresh; revisit if regeneration feels dumb.
- First-class visual-verification phase kind (§2.5) — separate spec.
