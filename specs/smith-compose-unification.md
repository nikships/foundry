# Smith Compose — merging the Orchestrator into Smith

**Status:** Approved (brainstorm reviewed 2026-09-12, all decisions settled)
**Companion artifact:** `.lavish/smith-orchestrator-unification.html` (options, diagrams, mocks, decision record)
**Linear:** [FOU-381](https://linear.app/foundry-nik/issue/FOU-381) (epic) → [FOU-382](https://linear.app/foundry-nik/issue/FOU-382) M-01 · [FOU-383](https://linear.app/foundry-nik/issue/FOU-383) M-02 · [FOU-384](https://linear.app/foundry-nik/issue/FOU-384) M-03 · [FOU-385](https://linear.app/foundry-nik/issue/FOU-385) M-04 · [FOU-386](https://linear.app/foundry-nik/issue/FOU-386) M-05 · [FOU-387](https://linear.app/foundry-nik/issue/FOU-387) M-06 · [FOU-388](https://linear.app/foundry-nik/issue/FOU-388) Android follow-up
**Supersedes:** the two-agent framing in `specs/orchestrated-runs.md` ("the Orchestrator") and `specs/smith-v2-in-app-chat.md` §"Orchestrator". Both specs' engine, rails, durability, and approval contracts stand unchanged.

## 1. Summary

Foundry ships two agentic systems that share a constitution, a runtime, and a job but not an identity, a model, a transcript, or a surface. The **Orchestrator** (`main/orchestrator/`) is a stateless, read-only, schema-bound one-shot that composes a run plan; **Smith** (`main/smith/`) is a persistent, tool-rich operator session. Smith already calls the Orchestrator through an approval-gated IPC hop (`smith_runs orchestrator_plan`), and pipeline healing already runs under Smith's persona from a file filed under `orchestrator/` (`replan.ts`).

This spec folds the Orchestrator into Smith as **Option B — one Smith, two turn kinds**:

- A **conversation turn** — today's `SmithChatSession` (persistent, full tools, approvals, receipts, voice).
- A **composition turn** — today's `PlanSession` one-shot (bounded, read-only, `submit_result` → rails → correction budget), now owned by Smith: Smith's persona, Smith's model hierarchy, Smith's transcript, a Smith artifact card, and a first-class `smith_compose` tool with no IPC hop.

Every capability of both systems is retained. The word "Orchestrator" leaves prompts, UI copy, settings, and code identifiers. The engine remains the sole judge of success: Smith proposes, code disposes.

## 2. Decision record

| Decision | Choice | Notes |
| --- | --- | --- |
| Direction | **Option B** — one Smith, two turn kinds | Keep the deterministic composition one-shot; unify identity, model, transcript, card, tool. Options A (chat-first) and C (in-session `submit_plan`) rejected — see artifact §03/§04. |
| Name | **Smith** | Already the persona, emblem, settings pane, voice, and website demo. "Orchestrator" was a role, not a character. |
| Approval policy | **compose / revise immediate; accept / discard / cancel keep approval cards** | A composition turn is read-only and was explicitly asked for in plain words. Run creation, tombstoning, and cancelling a live turn remain gated. YOLO semantics unchanged (approval waits only). |
| Runs composer | Stays as a dedicated fast path | It must work with no chat session open and with an `inherit` model on fresh installs (Linear, Companion). Relabelled "Smith composes". |
| Plan chat | **Deleted**; replaced by Smith conversation with the plan pinned | `PlanChat.tsx` goes. "Discuss in Smith" navigates to the project's Smith chat with a `plan` screen-context item. |
| Plan card | Becomes a `run_plan` Smith artifact kind | One renderer component for Runs › proposals and the Smith transcript. Bounded spec; plan JSON stays in the durable row. |
| Model resolution | One `resolveSmithModel(purpose, override?)` | Purposes `chat`, `compose`, `repair`. `compose`/`repair` never throw `ModelNotChosen`; they fall through to Agent Defaults then `inherit`. Chat keeps refusing to *send* on a truly unset model. |
| Code location | `main/orchestrator/` → `main/smith/compose/` | `replan.ts` comes home. `ipc/orchestrator.ts` → `ipc/smith-compose.ts`. |
| Push channels | `orchestrator-progress` → `smith-compose-progress` | Last PR, atomic across contract, preload, `api.ts`, `mockFoundry.ts`, `ipc/AGENTS.md`, tests. |
| Companion | `/v1/smith/compose` added; `/v1/orchestrator` aliased for one release | Android pins routes; remove the alias after an Android release. |
| Website | Out of scope | `apps/website` copy unchanged unless asked. |

## 3. Current state (verified against the tree)

### 3.1 The Orchestrator — `apps/desktop/src/main/orchestrator/`

| File | Role |
| --- | --- |
| `plan.ts` | `ORCHESTRATOR_PROMPT` ("You are the Orchestrator…"), `buildPlanPrompt`, `buildRefinePrompt`, `planOutputFormat` / `refineOutputFormat` (schema-bound `submit_result`), `parsePlanReply` / `parseRefineReply`, `checkPlanRails` (= `validate()` + `preflightForRun()` + composition issues), `configuredCastModels`, `toGeneratedPlan`. |
| `plan-session.ts` | `PlanSession` on `PanelSession<OrchestratorState>`; one read-only one-shot per turn (`access: 'read'`), `1 + envelopeRetries` correction budget, `message()` → `refine()` rebuilds the base prompt plus `messages[]`. `createPlans()` → `PanelRegistry`. |
| `proposals.ts` | `ProposalStore`: durable `proposals` rows via `Tracer`; `start`, `onProgress`, `list`, `get`, `cancel`, `discard`, exactly-once `accept` (in-flight lock + `accepted_run_id`), `restoreOnBoot`. Broadcasts `orchestrator-progress` and `proposals-changed`. |
| `start.ts` | `startPlan()` — shared guard + `plans.start()` for the IPC router and the Companion host. |
| `replan.ts` | `REPLAN_SYSTEM_PROMPT` ("You are Smith, repairing this Foundry pipeline"), `replanningSupport()`, `resolvePipelineHealingModel()`. Already Smith's persona. |
| `composition.ts`, `composition-rules.ts` | `compositionRuleBullets()` and rails shared by both prompts and `smith/system-prompt.ts`. |

Entry points: `ipc/orchestrator.ts` (Runs composer), `renderer/components/run/LinearComposer.tsx` (via the same IPC), `companion/host.ts` `/v1/orchestrator/*`, `smith/run-tools.ts` `orchestrator_*` operations (approval-gated, `write` risk, model resolved from `settings.defaultModel`), `engine/registry.ts` (replanner for pipeline healing).

Renderer: `RunsScreen.tsx` tab `orchestrator`, `OrchestratorPicker.tsx` ("The Orchestrator — every run answers to one mind"), `ProposalList.tsx` → `PlanCard.tsx` (brief, rationale, phases, recast, Start/Regenerate/Discard) + `PlanChat.tsx` ("Discuss with the Orchestrator"), `hooks/useOrchestratorPlan.ts`, `utils/orchestrator-choice.ts` (localStorage model/effort).

### 3.2 Smith — `apps/desktop/src/main/smith/`

`SmithService` (one `ProposalQueue`, lazily-opened `SmithChatSession` per project + global), `chat-session.ts` (persistent session over `SmithPiTransport`, successor sessions on model/effort switch, transcript cache, `absorbArtifact`, permission mode), `system-prompt.ts` (`SMITH_CHAT_HARNESS`, which today explains "the Orchestrator composes a run-specific pipeline" and instructs `smith_runs orchestrator_plan → orchestrator_get → … → orchestrator_accept`), fourteen tool modules, `present-tools.ts` (validated `SmithArtifact` kinds), `receipts.ts`, `capability-coverage.ts` (`immediate | approval | secure | renderer-only`).

Settings: `smithModel`, `smithReasoningEffort` (chat refuses to send when unset, `requireModel` in `SmithPiTransport.start`). Pipeline healing model: `smithModel` → `defaultModel` → `inherit`.

### 3.3 The seam that motivates the merge

1. Asking Smith to plan a run raises an approval card whose executor invokes `IPC.orchestratorPlan`, which opens a *different* agent whose answer arrives on `orchestrator-progress` — a channel Smith does not watch. Smith must poll `orchestrator_get`.
2. Two personas share one constitution (`compositionRuleBullets()`).
3. Two model settings (composer pick vs `smithModel`) and three model resolvers.
4. Two chat UIs (`PlanChat` vs the Smith transcript) and two "discuss the plan" affordances.
5. `replan.ts` is Smith living under `orchestrator/`.

## 4. Target architecture

```
ENTRY POINTS                         SMITH  (one identity · one model hierarchy · one transcript per scope)
Runs composer ───┐                   ┌────────────────────────┐   ┌──────────────────────────┐
Linear composer ─┼─ headless ───────▶│  Composition turn      │◀──│  Conversation turn        │
Companion phone ─┤   trunk           │  compose/session.ts    │   │  chat-session.ts          │
Engine healing ──┘                   │  one-shot · read-only  │   │  persistent · full tools  │
                                     │  submit_result → rails │   │  smith_compose tool ──────┘
Smith screen · voice ───────────────▶│  compose·revise·repair │   │  approvals · YOLO · cards │
                                     └───────────┬────────────┘   └─────────────┬─────────────┘
                                                 ▼                              ▼
                                     ProposalStore row (SQLite)  +  run_plan artifact card
                                                 │ accept (approval)
                                                 ▼
                                     Engine: startRun(plan) re-validates; phases fail closed
```

### 4.1 Main process layout after the move

```
main/smith/
  compose/
    plan.ts          ← orchestrator/plan.ts         (prompt renamed SMITH_COMPOSE_PROMPT)
    session.ts       ← orchestrator/plan-session.ts (class ComposeSession; state type ComposeState)
    proposals.ts     ← orchestrator/proposals.ts    (ProposalStore, unchanged behaviour)
    start.ts         ← orchestrator/start.ts        (startCompose)
    replan.ts        ← orchestrator/replan.ts       (SMITH_REPAIR_PROMPT)
    composition.ts, composition-rules.ts
    model.ts         NEW  resolveSmithModel(purpose, override?)
  compose-tools.ts   NEW  smith_compose tool factory
  chat-session.ts, index.ts, system-prompt.ts, …    (existing)
main/ipc/smith-compose.ts ← ipc/orchestrator.ts
```

`main/AGENTS.md` subsystem table: drop the `orchestrator/` row's implied existence; `smith/` reads "Native operator chat, composition turns, tools, and proposals." `smith/AGENTS.md` gains a "Composition turns" section (§4.6 below).

### 4.2 Persona

One preamble, two blocks:

- `SMITH_HARNESS_PREAMBLE` — "You are Smith, Foundry's native operator agent…" plus the "What Foundry is" section, rewritten in the first person: *"When the operator describes intent, you compose a run-specific pipeline; the operator confirms the plan; a team of bounded agents executes it in one shared worktree."*
- `SMITH_CHAT_HARNESS` = preamble + conversation block (existing "How you work", "Choose a tool", "Directing pipeline agents", "Presenting", "Entity schemas"). The "New run" bullet becomes: *"New run: `smith_compose` compose → the card arrives in this chat when ready → discuss → `smith_compose` accept (approval). Never invent a plan or pass one to `smith_propose`."*
- `SMITH_COMPOSE_PROMPT` = preamble + composition block (the body of today's `ORCHESTRATOR_PROMPT` with "You are the Orchestrator: inspect one request…" → "You are composing a run: inspect one request…"). Same `submit_result` contract, same security boundary, same tooling note.
- `SMITH_REPAIR_PROMPT` = preamble + today's `REPLAN_SYSTEM_PROMPT` body.

Rails, schemas, and few-shot content are unchanged. Golden plan snapshots are regenerated once in M-01 and diffed structurally.

### 4.3 Model resolution — `compose/model.ts`

```ts
export type SmithPurpose = 'chat' | 'compose' | 'repair';

export function resolveSmithModel(
  settings: Pick<AppSettings, 'smithModel' | 'smithReasoningEffort' | 'defaultModel' | 'defaultReasoningEffort'>,
  purpose: SmithPurpose,
  override?: { model?: string; reasoningEffort?: ReasoningEffort },
): { model: string; reasoningEffort: ReasoningEffort };
```

Order: explicit override → `smithModel`/`smithReasoningEffort` → `defaultModel`/`defaultReasoningEffort` → `{ model: 'inherit', reasoningEffort: smithReasoningEffort }`.

- `chat`: the result feeds `SmithPiTransport.start`, which keeps `requireModel` — a truly unset chain still refuses to send with `ModelNotChosen`. Behaviour unchanged.
- `compose` / `repair`: the result feeds a one-shot; `inherit` is legal and resolves inside pi as today. Never throws.
- Replaces `resolveOrchestratorModel` (`run-tools.ts`), `resolvePipelineHealingModel` (`replan.ts`), and the composer's `model || 'inherit'` handling in `ipc/orchestrator.ts` / `start.ts`.
- The composer's per-run override (`utils/orchestrator-choice.ts` → `utils/compose-choice.ts`, localStorage key unchanged for continuity) is passed as `override`. Its `inherit` label becomes **"Smith's model"**.

The cast pool (`configuredCastModels`) is unchanged: enabled catalog minus hidden models, with Agent Defaults and the composer override as *preferences*.

### 4.4 `smith_compose` tool — `compose-tools.ts`

Factory closes over `ProposalStore`, `SmithService`, settings, `startCompose` services, and the scope. Main-only calls, **not** the IPC invoker.

| op | class | args | behaviour |
| --- | --- | --- | --- |
| `compose` | immediate | `prompt`, `model?`, `reasoningEffort?`, `projectId?` (required in global scope) | `ProposalStore.start()` with `resolveSmithModel('compose', override)`. Returns `{ planId, status: 'generating' }` plus a note that the card arrives in this chat. Also triggers `warmStartPrep` exactly as `ipc/orchestrator.ts` does today. |
| `revise` | immediate | `planId`, `note` | `plans.message(planId, note)` (the existing `refine()`); the `note` is recorded as an operator message on the row. Returns `{ planId, status }` or the refusal reason. |
| `get` | immediate | `planId` | Bounded projection: `planId, projectId, status, detail, revision, refinedRequest, rationale, phases[{name, kind, agent?, model?, reasoningEffort?, command?}], synthesizedAgents[{name, purpose}], warnings[], acceptedRunId?`. Never `plan_json`, `raw_reply`, or `entries_json`. |
| `list` | immediate | `projectId?`, `includeAccepted?` | Same projection per row, `ready`/`generating`/`failed` first. |
| `accept` | **approval** (`write`) | `planId`, `plan?` | `ProposalStore.accept()` — exactly-once. `plan` is a full revised plan (recast), never a patch. |
| `discard` | **approval** (`destructive`) | `planId` | `ProposalStore.discard()`. |
| `cancel` | **approval** (`write`) | `planId` | `ProposalStore.cancel()`. |

- `orchestrator_*` operations are removed from `SMITH_RUN_OPERATIONS`; `capability-coverage.ts` maps `IPC.smithCompose*` channels to `smith_compose` with the classes above.
- Approval policy rationale (decision record): compose/revise spend a read-only model turn the operator asked for in plain words; they write nothing outside the proposal row. Accept creates a run; discard tombstones; cancel aborts a live turn — those stay gated. YOLO changes none of this (it only removes waits on the gated ops).
- Immediate classification still requires the tool to be *present*: it is registered only in Smith sessions (project and global), never in run sessions.

### 4.5 `run_plan` artifact

Add to the `SmithArtifact` union (`shared/types.ts`), `SMITH_ARTIFACT_VERSION` unchanged (additive kind):

```ts
export interface SmithRunPlanArtifact extends SmithArtifactBase {
  kind: 'run_plan';
  planId: string;
  projectId: string;
  status: ProposalStatus;          // generating | ready | failed | cancelled | discarded | accepted
  revision: number;
  title: string;                   // first sentence of refinedRequest, ≤ 120 chars
  refinedRequest: string;          // ≤ 2 000 chars
  rationale: string;               // ≤ 1 000 chars
  phases: Array<{ index: number; name: string; kind: 'agent' | 'code'; agent?: string; model?: string; reasoningEffort?: ReasoningEffort; command?: string; synthesized?: boolean }>;
  warnings: Array<{ where: string; message: string }>;   // ≤ 20
  acceptedRunId?: string;
}
```

- **Minted by main**, never model-presented (same rule as `action_receipt`). `SmithService` subscribes to `ProposalStore` transitions; on `ready`, each revision, `failed`, and `accepted` it `absorbArtifact`s into the proposing scope's chat (project scope of the row; also the global chat if the compose was issued there). Only an already-open chat receives one — opening a session to file a card is not allowed (existing receipt rule).
- **Persistence:** persisted as an inert snapshot like every artifact. Card actions (Start run, Recast, Discuss, Regenerate, Discard) re-read the live row through `api.compose.get(planId)`; a stale snapshot renders its status badge from the live row when available and "snapshot" when not.
- **Renderer:** `PlanCard.tsx` body is extracted into `components/smith/SmithRunPlanDesign.tsx` (+ `.module.css`), registered in the artifact registry, and used by `ProposalList.tsx` for the Runs proposals list. Recast (phase model/effort override before start) stays in the card. "Discuss in Smith →" replaces the embedded chat.
- `smith_present` gains no new kind; `run_plan` is not presentable. `capability-coverage`/present validation tests assert that.

### 4.6 Plan-pinned Smith context

`SmithScreenContext` (shared/ipc-contract.ts) gains:

```ts
plan?: { planId: string; revision: number };
```

- "Discuss in Smith" navigates to the Smith view with the project scope set to the plan's project and `plan` set. The Smith screen renders a **pinned strip** (planId, title, status, revision; Open card / Unpin) above the transcript; the strip is renderer state, cleared by Unpin or New chat.
- `screenContextBlock()` adds: *"A plan is pinned: `<planId>` (revision N). 'This plan', 'the proposal', or an unnamed revision request refers to it. Use `smith_compose` revise for changes and get for the current state."*
- `useSmithChat.send` already carries the screen context per turn; no new IPC.
- Historical rows keep `messages_json` (old PlanChat exchanges). `SmithRunPlanDesign` renders them read-only in an "Earlier discussion" disclosure so nothing is lost. `OrchestratorState.messages` → `ComposeState.messages` stays in the contract, documented as history-only; `revise` still appends to it so the conversation-about-a-plan remains reconstructable from the row.

### 4.7 Renderer surfaces

| Surface | Change |
| --- | --- |
| `RunsScreen.tsx` | `RunsMode` value `orchestrator` → `smith` (localStorage `foundry.runs.mode` migrates old value on read). Tab label **"Smith composes"** with the Smith emblem. Textarea placeholder: "Describe the change. Smith rewrites it into a behavior-level brief and composes the pipeline." |
| `OrchestratorPicker.tsx` → `ComposePicker.tsx` | Ceremony title **"Smith composes on"**, motto unchanged ("every run answers to one mind"). Inherit label **"Smith's model"**. `OrchestratorControls` → `ComposeControls` (used by `LinearComposer`). |
| `ProposalList.tsx` / `PlanCard.tsx` | Render `SmithRunPlanDesign`; "Discuss with the Orchestrator" → "Discuss in Smith →"; "The Orchestrator is considering…" → "Smith is composing…". |
| `PlanChat.tsx` | Deleted with its CSS. |
| `SmithScreen.tsx` | Pinned-plan strip; `SmithQuickPrompts` gains "Plan a run for…". Empty-state copy mentions composing runs. |
| `SettingsScreen.tsx` › Smith | Section note: "The model Smith chats and composes run plans on. `Smith's model` on the Runs composer follows this; unset follows Agent Defaults." |
| `Sidebar` Activity | Proposal rows unchanged (they read `ProposalSnapshot`). |
| `mockFoundry.ts`, `api.ts`, `preload/bridge.ts` | Follow the contract rename in M-06. |

Copy inventory to purge (desktop only): `OrchestratorPicker`, `PlanChat`, `PlanCard`, `RunsScreen`, `LinearComposer`, `useOrchestratorPlan`, `plan-view.ts`, `proposals-view.ts`, `smith-copy.ts`, `smith-chat-view.ts` quick prompts, `SmithQuickPrompts`, `agent-sound-cues.ts` labels, `settings-search.tsx` keywords, `main/smith/system-prompt.ts`, `main/orchestrator/*` comments, `main/AGENTS.md` "Model casting" ("Orchestrator pins" → "Smith compose override"), `main/ipc/AGENTS.md`.

### 4.8 IPC and push channels (M-06)

| Before | After |
| --- | --- |
| `IPC.orchestratorPlan/Message/Cancel/List/Get/Accept/Discard` (`orchestrator:*`) | `IPC.smithComposeStart/Revise/Cancel/List/Get/Accept/Discard` (`smith-compose:*`) |
| `IPC.eventOrchestratorProgress` (`event:orchestrator-progress`) | `IPC.eventSmithComposeProgress` (`event:smith-compose-progress`) |
| `FoundryApi.orchestrator.*` | `FoundryApi.compose.*` |
| `OrchestratorState`, `OrchestratorAcceptResult`, `PlanChatMessage.role: 'orchestrator'` | `ComposeState`, `ComposeAcceptResult`, `role: 'smith'` (old rows read `'orchestrator'` → mapped on read) |
| Push list in `ipc/AGENTS.md` | `smith-compose-progress` replaces `orchestrator-progress` |
| Companion `/v1/orchestrator/*` | `/v1/smith/compose/*` + alias `/v1/orchestrator/*` → same handlers for one release |

`proposals-changed` and the `proposals` table are unchanged (rows are user data; additive only).

### 4.9 Invariants that do not move

- Composition turns stay `access: 'read'` with no write tool; the engine's post-call `git diff` boundary check is unaffected.
- `Tracer` remains the only SQLite writer; `ProposalStore` writes through it.
- `startRun(plan)` re-validates via `checkPlanRails`; accept is exactly-once via `accepted_run_id`.
- Approval for run creation, kill, discard, merge, Git/PR, credentials, lifecycle, and network actions is unchanged; YOLO affects waits only.
- Secrets never reach a composition prompt or a `run_plan` card; artifact validation rejects secret-shaped strings as `smith_present` does.
- Pi imports stay in `src/main/pi/`; the move touches no vendor import.
- One worktree per run; the compose path never touches a worktree.

## 5. Migration plan — six PRs

Each PR ships alone, passes `pnpm run check`, and uses the `[component] Brief description` title format. UI-touching PRs are validated with the `foundry-ui` skill against the built Electron app.

### M-01 · `[smith] Rename the Orchestrator to Smith in prompts and UI`

Scope: copy and persona only; no contract change.

- `plan.ts`: `ORCHESTRATOR_PROMPT` → `SMITH_COMPOSE_PROMPT` wording per §4.2 (export the old name as a deprecated alias until M-02 removes it).
- `replan.ts`: `REPLAN_SYSTEM_PROMPT` → `SMITH_REPAIR_PROMPT` wording.
- `smith/system-prompt.ts`: first-person "What Foundry is"; "New run" bullet interim wording still names `smith_runs orchestrator_plan` (tool collapses in M-05).
- Renderer copy per §4.7 inventory (labels, placeholders, thinking text, quick prompts, settings note, search keywords). `RunsMode` value stays `orchestrator` until M-06.
- Regenerate `tests/main/orchestrator/__snapshots__` goldens; assert structural equality of plans before/after (phases, agents, acceptance) in the PR description.

Acceptance: no user-visible string in `apps/desktop` contains "Orchestrator" except `RunsMode`/IPC identifiers and historical-row rendering; `golden-plans.test.ts` passes with regenerated snapshots; `pnpm run check` green.

### M-02 · `[smith] Move main/orchestrator to main/smith/compose and unify model resolution`

- `git mv` per §4.1; update imports (`context.ts`, `engine/registry.ts`, `engine/executor.ts`, `companion/host.ts`, `ipc/index.ts`, `smith/run-tools.ts`, `smith/system-prompt.ts`).
- Rename classes/types: `PlanSession` → `ComposeSession`, `createPlans` → `createComposeSessions`, `startPlan` → `startCompose`, `PlanStart*` → `ComposeStart*`. Keep `ProposalStore` and `ProposalSnapshot` names.
- Add `compose/model.ts` `resolveSmithModel` (§4.3) with tests; route `run-tools.ts`, `replan.ts`, `ipc/orchestrator.ts`, `companion/host.ts` through it. Delete `resolveOrchestratorModel` and `resolvePipelineHealingModel`.
- Move tests `tests/main/orchestrator/*` → `tests/main/smith/compose/*`.
- Update `main/AGENTS.md` (subsystem table, "Model casting"), `smith/AGENTS.md` (new "Composition turns" section), `engine/AGENTS.md` reference to the replanner path.

Acceptance: `rg -n "orchestrator/" apps/desktop/src` returns only `ipc/orchestrator.ts` (renamed in M-06 to avoid a preload churn here) and historical comments; `resolveSmithModel` unit tests cover all three purposes and the never-throws property for compose/repair; `knip` reports no new dead exports.

### M-03 · `[smith] Add the run_plan artifact and render the plan card from it`

- `shared/types.ts`: `SmithRunPlanArtifact` (§4.5) added to the union and to `SmithArtifactKind`; bounded-spec validator in `present-tools.ts` (shared validation helpers) with an explicit "not presentable" guard and test.
- `smith/index.ts`: subscribe to `ProposalStore` transitions (new `onTransition` hook on the store, fired from `writeProgress`, `cancel`, `discard`, `accept`); mint and `absorbArtifact` into the proposing scope; record the issuing scope on the row-side map so global-chat composes land in the global transcript.
- Renderer: extract `PlanCard` body → `components/smith/SmithRunPlanDesign.tsx`; register in `SmithArtifactCard`; `ProposalList` renders it; "Discuss in Smith →" button (wired to a no-op-with-tooltip until M-04, or hidden behind the pinned-context capability flag — choose hidden).
- Card actions re-read the live row via `api.orchestrator.get` (renamed in M-06).
- `components/inspector/entries.tsx` untouched (no new trace events).

Acceptance: `smith-present-tools` tests reject a model-presented `run_plan`; `smith-service` test shows a `ready` transition producing exactly one card in the open project chat and none when no chat is open; renderer view-model test for the bounded projection; Electron smoke shows the card in Runs and in Smith after a seeded proposal (`FOUNDRY_E2E_SMITH_PROPOSAL`-style seed for a ready row).

### M-04 · `[smith] Pin a plan in Smith and delete PlanChat`

- `SmithScreenContext.plan` (§4.6); `screenContextBlock` wording; `App.tsx` navigation handler `onDiscussPlan(planId)`; pinned strip component `SmithPinnedPlan.tsx` (+ CSS) with Open card / Unpin.
- `smith_runs` interim: `orchestrator_message` becomes immediate and returns the bounded projection (the approval decision applies from here even before the tool collapse). Everything else in `smith_runs` unchanged until M-05.
- Delete `PlanChat.tsx` / `.module.css`; remove `PlanCard` discuss section; `SmithRunPlanDesign` renders historical `messages[]` read-only in an "Earlier discussion" disclosure.
- Update `renderer/AGENTS.md` note ("Smith screen and launcher share optional project scope") to mention plan pinning.

Acceptance: renderer tests for `smith-scope`/`smith-chat-view` cover pinned context; `smith-system-prompt.test.ts` covers the plan block; `knip` confirms `PlanChat` gone; `foundry-ui` walkthrough: compose in Runs → Discuss in Smith → pinned strip → "split the build" → revised card appears inline → Start run raises approval card.

### M-05 · `[smith] Add smith_compose and retire the orchestrator_* run operations`

- `compose-tools.ts` factory (§4.4) registered in `context.ts` for project and global scopes; `warmStartPrep` hook shared with the IPC router via a small `compose/after-start.ts` helper.
- Remove `orchestrator_*` from `SMITH_RUN_OPERATIONS`, `RISKS`, `ACTION_CHANNELS`, and the tool description; `capability-coverage.ts` maps the compose channels to `smith_compose` with `immediate | approval` classes per §4.4.
- `system-prompt.ts` "New run" bullet final wording; `SmithQuickPrompts` "Plan a run for…"; voice mode inherits the tool.
- Tests: `smith-orchestrator-tools.test.ts` → `smith-compose-tools.test.ts` (immediate compose returns a planId and no proposal card; revise refuses while generating; accept goes through `ProposalStore.accept` exactly once under concurrent calls; global scope requires `projectId`; `get` never returns `plan_json`); `smith-capability-coverage.test.ts` parity.

Acceptance: `pnpm exec vitest run -t "smith"` green; coverage classification test passes; the system prompt contains no `orchestrator_` operation names.

### M-06 · `[ipc] Rename compose channels and the Companion route`

- `shared/ipc-contract.ts`: constants, types, `FoundryApi.compose`, push channel per §4.8; `PlanChatMessage.role` read-mapping for old rows in `ProposalStore.list/get`.
- `preload/bridge.ts`, `renderer/api.ts`, `mockFoundry.ts`, `hooks/useOrchestratorPlan.ts` → `useComposePlan.ts`, `utils/orchestrator-choice.ts` → `compose-choice.ts` (same storage key), `RunsMode` `orchestrator` → `smith` with read-migration, `ipc/orchestrator.ts` → `ipc/smith-compose.ts`, `ipc/AGENTS.md` push list, `ipc-surface`/`ipc-clone`/`ipc-invoker` tests.
- `companion/host.ts`: add `/v1/smith/compose/*`; keep `/v1/orchestrator/*` dispatching to the same handlers with a `Deprecation` header; open a follow-up Android ticket to switch routes, after which the alias is removed.
- Final `rg -in "orchestrator" apps/desktop` sweep; allowed residue: DB column-free (none), historical `role: 'orchestrator'` read-mapping, the Companion alias, and `specs/orchestrated-runs.md`.

Acceptance: `ipc-surface.test.ts` lists `smith-compose-progress` and not `orchestrator-progress`; `mockFoundry` tracks `FoundryApi`; Electron smoke passes; Companion tests hit both route prefixes.

## 6. Test strategy

- No model or network in tests. Composition turns use `tests/helpers/scripted-oneshot.ts`; chat uses `scripted-transport.ts`; engine paths use real Git temp repos.
- Golden plans regenerate once (M-01) and are then stable through M-06 (prompt text does not change again).
- Add a cross-cutting `smith-compose-parity.test.ts` in M-05: the Runs composer path (`startCompose` via IPC) and the chat path (`smith_compose.compose`) produce identical `ProposalSnapshot` rows for the same inputs and services.
- Renderer: view-model tests for the bounded projection, pinned context, and copy; no jsdom.
- Electron smoke (`pnpm run test:e2e`) after M-03, M-04, M-06.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Golden snapshot churn hides a real plan regression | Regenerate only in M-01; PR description includes a structural diff (phase names, kinds, agents, acceptance) showing no change. |
| Compose path inherits Smith's `ModelNotChosen` refusal and breaks fresh installs / Linear / Companion | `resolveSmithModel('compose')` is typed and tested to never throw; `SmithPiTransport` is not used for composition turns. |
| Transcript bloat from plan content | `run_plan` spec is bounded (§4.5 limits); `get`/`list` projections exclude `plan_json`, `raw_reply`, `entries_json`. |
| Channel rename touches four surfaces plus tests | M-06 is one atomic PR; `ipc-surface.test.ts` is the gate. |
| Android pins `/v1/orchestrator` | Alias for one release with a `Deprecation` header; separate Android ticket. |
| Old proposals' `messages[]` from PlanChat become unreachable | Rendered read-only in the card's "Earlier discussion" disclosure; `revise` keeps appending to the same array. |
| Global-scope compose has no checkout for the one-shot `cwd` | `compose` requires `projectId` in global scope and runs the one-shot at that project's path, as `startCompose` does today. |
| Immediate compose lets a runaway chat loop spend turns | Tool result tells Smith the card arrives asynchronously and to stop; `ComposeSession` already serialises refine turns; add a per-chat soft cap of 3 concurrent `generating` rows with a clear refusal message. |

## 8. Out of scope

- Option C (in-session `submit_plan`) — a possible later upgrade of the `compose` op; not part of this spec.
- Any change to engine phase semantics, gates, healing budgets, or worktree rules.
- `apps/website` copy and demos.
- Android UI changes beyond the route switch ticket.
- Multi-thread Smith chats or per-plan transcripts (the pinned-context model was chosen instead).

## 9. Resolved questions

| Question | Answer |
| --- | --- |
| Which option? | B. |
| Approval for compose/revise from chat? | Immediate. Accept/discard/cancel keep cards. |
| Name? | Smith. |
| Does the Runs composer survive? | Yes, relabelled; it is the headless fast path. |
| Where does "discuss the plan" live? | In Smith, with the plan pinned via screen context. |
| Is the plan JSON ever in the model's context? | No. Bounded projections only. |
