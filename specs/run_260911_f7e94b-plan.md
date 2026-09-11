# Plan — Android parity with desktop (run_260911_f7e94b)

## 0. Reading guide

- **Source of truth for what Android may be:** `specs/companion-android-ui.md` + `apps/android/README.md`.
  Android is a bounded 6-route **operator surface** (Pair / Runs / NewRun / Smith / RunDetail / Inspector + ConnectionBottomSheet overlay), not a desktop mirror.
- **Source of truth for the phone↔desktop contract:** `apps/desktop/src/shared/companion.ts` (`COMPANION_PROTOCOL_VERSION`, `CompanionRoutes`) implemented by `apps/desktop/src/main/companion/host.ts`.
- **Scope audit input (read-only, no files changed):** prior phase found protocol **v6 in sync** on both sides, broad Android parity already (orchestrator options/start/state/cancel, linear, kill/continue, checkpoints/restore, PR status/draft/create, Smith chat/proposals/model/effort), and exactly **two true gaps** (orchestrator list/accept, interrupt-answer write path). Everything else in the request ("mirror everything", "single model xhigh-only", "screenshots as gate", "since last touched") contradicts shipped contracts — this plan resolves each contradiction explicitly so the builder never guesses.
- **Do not implement desktop-mirror work.** §4 of `specs/companion-android-ui.md` and `apps/android/README.md` ("There is no Settings graph", "Do not invent a second engine") forbid it.

## 1. Dedicated scope-identification step (THOROUGH, do first, before any code)

The builder MUST complete this step and record its output as a table in the PR description / build notes. No code changes until 1.5 is done.

### 1.1 Establish "last touched" with history (scout could not — no git-log tool)

Run from the pipeline worktree root:

```bash
git log --oneline -20 -- apps/android
git log --oneline -20 -- apps/desktop/src/shared/companion.ts apps/desktop/src/main/companion/host.ts
git log --oneline -20 -- specs/companion-android-ui.md
git diff $(git log --format=%H -1 -- apps/android)..HEAD --stat -- apps/desktop/src/shared/companion.ts apps/desktop/src/main/companion/host.ts apps/desktop/src/shared/ipc-contract.ts apps/desktop/src/shared/types.ts
```

Record: (a) last Android-touch commit hash+date, (b) every `companion.ts` / `host.ts` commit since that date, (c) whether `COMPANION_PROTOCOL_VERSION` changed (currently `6` both sides — see §2).

### 1.2 Re-verify protocol sync (do not assume stale premise)

- Read `apps/desktop/src/shared/companion.ts:24` (`COMPANION_PROTOCOL_VERSION = 6`) and `apps/android/app/src/main/java/com/foundry/companion/data/model/CompanionTypes.kt:5` (same constant).
- Read `CompanionRoutes` in full (`apps/desktop/src/shared/companion.ts:240-330` approx): `POST /pair`, `GET /v1/session`, `GET /v1/projects*`, `POST /v1/runs`, orchestrator (options / plans POST / plans/:planId GET / cancel / list `GET /v1/orchestrator/plans` / accept `POST /v1/orchestrator/plans/:planId/accept`), linear (state / issues / issue / workflow-states / runs POST), kill/continue, checkpoints/restore, PR status/draft/create, smith (state/send/cancel/new-chat/proposals/answer/models/model/effort), events poll `events?after=<changeId>`.
- For each route, grep `HttpCompanionRepository.kt` for the corresponding method (`getOrchestratorOptions`, `startOrchestratorPlan`, `getOrchestratorPlan`, `cancelOrchestratorPlan`, `getLinearState`, `searchLinearIssues`, `getLinearIssue`, `getLinearWorkflowStates`, `startLinearRun`, `killRun`, `continueRun`, `getRestorableCheckpoints`, `restoreCheckpoint`, `getPrStatus`, `getPrDraft`, `createPr`, `getSmithState`, `sendSmith`, `cancelSmith`, `newSmithChat`, `getSmithProposals`, `answerSmithProposal`, `getSmithModels`, `setSmithModel`, `setSmithEffort`). Mark present/missing. Expected result per audit: only `GET /v1/orchestrator/plans` (list) and `POST .../accept` missing; everything else present.
- Confirm error-copy handling in `HttpCompanionRepository.kt`: HTTP 409 → protocol-mismatch copy, 401 → pairing-invalid copy (must match desktop contract; do not reword).

### 1.3 Inventory "everything in desktop" and triage into MUST / MUST-NOT

List every desktop surface with no Android counterpart and explicitly mark MUST-NOT per spec §4:

- MUST-NOT (never build): `apps/desktop/src/renderer/screens/DesignScreen.tsx`, `PipelinesScreen.tsx`, `RosterScreen.tsx`, `PullRequestsScreen.tsx`, `SettingsScreen.tsx`, `onboarding/WelcomeScreen.tsx|ProvidersScreen.tsx|ProjectScreen.tsx|DoctorScreen.tsx`, `components/pipeline/*`, `components/project/*`, `components/readiness/*`, bridge/providers/tavily/linear-settings/maintenance/updater/doctor IPC in `apps/desktop/src/shared/ipc-contract.ts`, pipeline/roster/envelope editors, worktree merge/discard, providers/Bridge/API keys, readiness doctor, PR board, archive management, accounts/cloud/WAN, tablets/landscape, light theme.
- MUST (the only true gaps — see §3): orchestrator durable list/accept; engineer-interrupt answer write path (§3.7).
- DECIDE (drift beyond spec — see §5): Smith client already shipped on Android (`SmithScreen.kt`, `SmithArtifactCard.kt`, Smith route in `FoundryNavHost.kt`, `CompanionViewModel.loadSmith/sendSmith/...`) although spec §4 lists "Smith … desktop surfaces" as absent. Builder must pick KEEP (update spec §4) or REMOVE (delete Smith route+screen+VM methods) — default KEEP, because removal is destructive and Smith routes are already in `companion.ts`. Do not invent additional surfaces either way.

### 1.4 Model-catalog check (reject single-model premise)

- Read `apps/desktop/src/shared/direct-providers.ts`: `DIRECT_PROVIDERS` ships `meta/muse-spark-1.3` AND `muse-spark-1.3-contributor` with `SPARK_THINKING` map `{off:null, minimal..xhigh:string, max:null}` and `ReasoningEffort` type `off/minimal/low/medium/high/xhigh/max`.
- Read `apps/android/.../util/ReasoningEfforts.kt`: `KNOWN_REASONING_EFFORTS` (all 7), `supportedReasoningEfforts()` / `normalizeReasoningEffortForModelChoice()` against dynamic `SmithModelInfo` / `OrchestratorOptions` catalogs.
- Conclusion to record: model+effort are **per-phase dynamic choices**, not a fixed single value. Do not hardcode `muse-spark-1.3/xhigh` anywhere except as a default/fallback (see §6).

### 1.5 Verification-rules check (reject screenshot-as-gate premise)

- Android screenshots are **Robolectric-rendered PNGs** via `renderToBitmap()` in `apps/android/app/src/test/java/com/foundry/companion/RunsScreenScreenshotTest.kt` (+ Pair/NewRun/RunDetail/Inspector/ConnectionHealth screenshot tests), writing to `screenshots/` (gitignored / absent in checkout). They are unit-test artifacts, not photos of a working phone.
- Root `AGENTS.md`: "Do not run Android builds or tests in an orb, rely on the CI Android job." `apps/desktop/AGENTS.md`: real-Electron validation via foundry-ui skill; no browser/throwaway-Playwright.
- Authoritative gates: `npm run check` (JS gate ignores `apps/android/` per `apps/android/README.md`) + `.github/workflows/ci.yml` + `android-package.yml` (`./gradlew :app:testDebugUnitTest` in `apps/android`). Record this; do not accept manual device screenshots as the gate (see §7).

## 2. Baseline: what is already in sync (change nothing unless broken)

- Protocol v6 both sides; 409/401 copies in `HttpCompanionRepository.kt`.
- Navigation: `apps/android/.../ui/navigation/NavRoutes.kt` (Pair/Runs/NewRun/Smith/RunDetail/Inspector) + `FoundryNavHost.kt` (NavHost + ConnectionBottomSheet overlay, `needsSynthesizedHome()` for `foundry://run/<runId>` deep link with Home synthesized beneath). No bottom tabs, no Settings graph.
- NewRun modes Manual/Orchestrator/Linear in `NewRunScreen.kt` + `CompanionViewModel.kt`; RunDetail restore/continue/PR flows in `RunDetailScreen.kt`; transcript read-only `INTERRUPT` banner in `ui/screens/inspector/components/TranscriptLane.kt:296` + `data/model/TranscriptEvents.kt` (`INTERRUPT` kind).
- If 1.2 shows any other route missing besides the two gaps below, add it to §3 as a P0 with the same pattern (types → repository interface → HTTP impl → ViewModel → UI → tests).

## 3. True gaps to build (the entire code scope unless 1.2 finds more)

### 3.1 Gap 1 — Orchestrator durable list + exactly-once accept (P0)

Desktop contract (read-only reference, do not change):

- `apps/desktop/src/shared/companion.ts:268` — `GET /v1/orchestrator/plans → ProposalSnapshot[]` ("Durable proposal list for a project; same rows the Activity sidebar reads").
- `apps/desktop/src/shared/companion.ts:270` — `POST /v1/orchestrator/plans/:planId/accept` with `CompanionOrchestratorAcceptRequest { plan?: GeneratedRunPlan } → OrchestratorAcceptResult` ("Exactly-once accept; the accepted snapshot becomes the run plan").
- `apps/desktop/src/main/companion/host.ts → orchestratorRoute()` — list/accept via `CompanionOrchestratorDeps.list/accept`.

Current Android defect: `HttpCompanionRepository.kt` has only options/start/state/cancel; `CompanionViewModel.startOrchestratedRun()` starts via `POST /v1/runs` with a plan instead of exactly-once accept.

Exact changes:

1. `apps/android/app/src/main/java/com/foundry/companion/data/model/CompanionTypes.kt` — add (if absent; reuse existing `ProposalSnapshot`, `GeneratedRunPlan`, `OrchestratorAcceptResult` shapes verbatim from `apps/desktop/src/shared/companion.ts` + `ipc-contract.ts`; `ignoreUnknownKeys=true` already set so additive fields are safe):
   - `CompanionOrchestratorAcceptRequest(plan: GeneratedRunPlan? = null)` with `explicitNulls=false` semantics (null plan must mean "no plan", cf. existing `Json { explicitNulls=false }` comment in `HttpCompanionRepository.kt:30-35`).
   - Ensure `ProposalSnapshot` and `OrchestratorAcceptResult` Kotlin models match desktop fields exactly (no renaming).
2. `apps/android/app/src/main/java/com/foundry/companion/data/repository/CompanionRepository.kt` — add to interface:
   - `suspend fun listOrchestratorPlans(projectId: String? = null): Result<List<ProposalSnapshot>>` (check desktop query-param shape in `host.ts`; if list takes no params, take none — mirror exactly).
   - `suspend fun acceptOrchestratorPlan(planId: String, plan: GeneratedRunPlan? = null): Result<OrchestratorAcceptResult>`.
3. `apps/android/app/src/main/java/com/foundry/companion/data/repository/HttpCompanionRepository.kt` — implement both with Bearer auth, same 401/409 mapping as neighbours:
   - `GET /v1/orchestrator/plans` → `ListSerializer(ProposalSnapshot.serializer())`.
   - `POST /v1/orchestrator/plans/{planId}/accept` with URL-encoded `planId` (`URLEncoder.encode(..., UTF_8)` as per file's existing pattern), JSON body `CompanionOrchestratorAcceptRequest`.
   - Mirror in `FakeCompanionRepository.kt` (find via `apps/android/**/FakeCompanionRepository.kt`): in-memory plan list + accept returns canned `OrchestratorAcceptResult` so offline demos/tests work.
4. `apps/android/app/src/main/java/com/foundry/companion/viewmodel/CompanionViewModel.kt` (exact path may be `viewmodel/CompanionViewModel.kt` — confirm with find) — add `listOrchestratorPlans()` state flow + rewrite `startOrchestratedRun(planId, editedPlan?)` to call `acceptOrchestratorPlan()` (exactly-once) instead of `POST /v1/runs`; surface accept errors verbatim; on success navigate to Run operator for the returned run id and pop New Run.
5. `apps/android/app/src/main/java/com/foundry/companion/ui/screens/newrun/NewRunScreen.kt` (confirm path with find) — where an orchestrator plan is previewed, add "Accept plan → start run" primary action wired to the new VM method; keep existing options/start/poll/cancel polling UI unchanged; disable Accept while reconnecting/offline per §1.4 connection model.
6. Tests: extend `apps/android/app/src/test/java/com/foundry/companion/**/*Test.kt` (JUnit + Robolectric; find existing repository/VM tests): HTTP fake-engine test for list (200 → list, 401/409 mapping), accept (200 → result, double-accept server-error surfaced), VM test that accept (not direct `POST /v1/runs`) is called. Update Robolectric screenshot test for NewRun orchestrator-accept state if a screenshot test exists for NewRun (follow `RunsScreenScreenshotTest.kt` pattern: `renderToBitmap()` → `screenshots/`).

### 3.2 Gap 2 — Engineer-interrupt answer write path, spec §3.7 (P0)

Spec contract (copy verbatim, do not reword — `specs/companion-android-ui.md:399-412`):

- High-priority notification "⟨pipeline⟩ is waiting on you" (fires even with settle toggle off).
- Home run row/card amber `waiting` chip; Run screen pinned amber strip above header: "An engineer phase is waiting for your answer." + `Answer…`.
- `Answer…` opens modal sheet: interrupt question, optional notes field, `Approve` (primary) + `Reject`. **Dismiss does NOT answer** — strip persists. (Desktop Escape rejects; phone swipe must not.)
- Offline: strip shows but `Answer…` disabled with "Reconnect to answer".
- Connection model: mutating actions disabled while not connected; phone never queues writes.

Current Android defect: read-only only (`TranscriptLane.kt:296 BannerRow INTERRUPT`, `TranscriptEvents.kt INTERRUPT` kind). Grep for `answerInterrupt|Answer...|waiting chip` returns nothing; `CompanionRepository.kt` exposes `answerSmithProposal` but no interrupt-answer method.

Exact changes (mirror desktop `InterruptSheet` contract; confirm interrupt route/payload in `host.ts` + `companion.ts` during 1.2 — if desktop exposes e.g. `POST /v1/runs/:runId/interrupts/:interruptId/answer { decision: approve|reject, notes?: string }`, mirror names exactly; names below are placeholders to be corrected to the located contract):

1. `CompanionTypes.kt` — add `InterruptAnswerDecision` (`approve|reject`), `CompanionInterruptAnswerRequest(decision, notes?)`, and ensure interrupt event model carries `interruptId`, `question`, `phaseId`, `runId`.
2. `CompanionRepository.kt` — add `suspend fun answerInterrupt(runId: String, interruptId: String, decision: ..., notes: String?): Result<Unit>` (or desktop's response shape).
3. `HttpCompanionRepository.kt` + `FakeCompanionRepository.kt` — implement with Bearer auth + 401/409 mapping; Fake holds a pending-interrupt flag so Answer sheet can be exercised offline in demos.
4. Notification: `apps/android/.../notification/*` (confirm path; spec §3.7 + line 383 covering accepted/rejected/failed/killed and engineer-waiting alerts) — fire high-priority "⟨pipeline⟩ is waiting on you" even when settle toggle off.
5. UI:
   - Home/Runs row: amber `waiting` chip when run has pending interrupt (reuse status-color mapping from spec §2.2; dark-only tokens from `tokens-factory.css` via existing Kotlin token file — find via `ui/theme/*`).
   - `RunDetailScreen.kt` (Run operator): pinned amber strip above header with exact copy "An engineer phase is waiting for your answer." + `Answer…` button; `Answer…` disabled with "Reconnect to answer" while reconnecting/offline.
   - New `AnswerInterruptSheet.kt` (place alongside `ConnectionBottomSheet` / Inspector components): shows question, optional notes `TextField`, `Approve` primary + `Reject`; dismiss (back/scrim) = no call; only button taps call `answerInterrupt`. Strip persists until server confirms answered.
   - `CompanionViewModel.kt`: `pendingInterrupt` state derived from run detail/events poll; `answerInterrupt()` with in-flight guard (no double-tap double-answer), error surfaced verbatim, strip persists on error.
6. Tests: repository HTTP test (200/401/409), VM test (dismiss makes zero calls; Approve calls once with notes; offline disables), Robolectric screenshot tests for waiting chip + pinned strip + Answer sheet (follow existing screenshot-test pattern). Manual high-priority notification verified via `adb` + Fake repo (see §7), not as gate.

### 3.3 Subtractions

None required beyond the Smith decision in §5. Do not delete anything else. Do not backport desktop-only surfaces to Android.

## 4. Dedicated plan for the massive scope (how "everything" is handled without building everything)

The request's literal reading ("everything that has happened in desktop since Android was last touched") is unbounded: desktop ships renderer screens, pipeline/roster/envelope editors, worktree git surgery, providers/Bridge/keys, doctor/preflight, PR board, archive, settings, onboarding, cloud/WAN — all MUST-NOT per §4. This section is the containment plan the builder must follow:

1. **Default-deny filter:** any desktop change that is not (a) a `CompanionRoutes`/payload/auth change in `companion.ts`/`host.ts`, or (b) a renderer copy/token change explicitly referenced by `specs/companion-android-ui.md` §5 ("reuse it verbatim"), is out of scope. Cite the spec section when rejecting.
2. **Wave structure (stop after Wave 1 unless 1.2 proves more):**
   - Wave 0 (this plan §1): scope-identification table. Half-day.
   - Wave 1 (P0, this plan §3): orchestrator list/accept + interrupt answer + tests + spec touch-ups. The only wave authorized.
   - Wave 2+ (only if 1.2 finds additional `companion.ts`/`host.ts` drift): one wave per route-group (linear / checkpoints / PR / Smith), each mirroring the §3.1 pattern (types → interface → HTTP → Fake → VM → UI → tests). Builder must write a Wave-2 addendum plan and get review before coding it — do not roll it into Wave 1.
3. **No new routes without desktop:** phone never invents endpoints. If a desired phone action has no `CompanionRoutes` entry, stop and file a desktop `host.ts` ticket instead of adding a client-only hack.
4. **Protocol-bump rule:** if desktop bumped `COMPANION_PROTOCOL_VERSION` since last Android touch, Android updates `CompanionTypes.kt:5` to match and verifies 409 copy — that is the whole bump task. Do not fork version logic.

## 5. Smith drift decision (one-line choice, then mechanical steps)

- **Default: KEEP Smith.** It is already built (`ui/screens/smith/SmithScreen.kt`, `SmithArtifactCard.kt`, Smith route, VM methods) and wired to shipped `companion.ts` Smith routes. Update `specs/companion-android-ui.md` §4 to remove "Smith" from the absent list and note Smith as a shipped exception (one-line spec edit + keep `NavRoutes.kt`/`FoundryNavHost.kt` unchanged).
- **Alternative: REMOVE Smith** (only if reviewer insists spec §4 is normative over shipped code): delete Smith route from `NavRoutes.kt` + `FoundryNavHost.kt`, delete `ui/screens/smith/*`, remove Smith methods from `CompanionRepository.kt`/`HttpCompanionRepository.kt`/`FakeCompanionRepository.kt`/`CompanionViewModel.kt`, remove Smith screenshot tests, update README screen list. This is destructive — do not do both; pick one.

## 6. Model policy (explicit rejection of "only Muse Spark 1.3 xhigh")

- **Do not** hardcode a single model or single effort. Keep `DIRECT_PROVIDERS` catalog on desktop untouched; keep `ReasoningEfforts.kt` (`KNOWN_REASONING_EFFORTS`, `supportedReasoningEfforts()`, `normalizeReasoningEffortForModelChoice()`) untouched.
- Model/effort pickers (Smith model/effort, Orchestrator model/effort in New Run) stay backed by dynamic server catalogs (`getSmithModels`, `getOrchestratorOptions`). `muse-spark-1.3` + `xhigh` may remain the **default selection** where the catalog marks them default, but all 7 efforts (`off/minimal/low/medium/high/xhigh/max`) and all catalog models must remain selectable. Any builder change that removes a model or effort level fails review.
- Verify with: VM/catalog unit test asserting `supportedReasoningEfforts()` passthrough + screenshot test showing picker with multiple models (existing Smith/NewRun screenshot tests).

## 7. Verification (screenshots scoped correctly + authoritative gates)

### 7.1 What "verify with screenshots" means in this repo (do not do manual device-photo gates)

- Update/extend the existing Robolectric screenshot tests (pattern in `RunsScreenScreenshotTest.kt`: Compose content under `FoundryTheme` in `Robolectric` activity, `renderToBitmap()`, PNG to `screenshots/`):
  - New: orchestrator-accept state (Wave 1 §3.1).
  - New: waiting chip on Home row, pinned waiting strip on Run, Answer sheet open with Approve/Reject (Wave 1 §3.2).
  - Keep: Pair/NewRun/RunDetail/Inspector/ConnectionHealth screenshots green.
- `screenshots/` is gitignored/absent — regenerate locally; attach PNGs to the PR as evidence, but they are **not the gate**.

### 7.2 Authoritative gates (must all pass; run don't assert)

- From `apps/android/` (CI Android job mirrors this; **do not run Android builds/tests in an orb — rely on CI** per root `AGENTS.md`; run locally only if the environment proves SDK/JDK 21 present, otherwise cite CI):
  ```bash
  ./gradlew :app:testDebugUnitTest
  ```
  (covers JUnit + Robolectric screenshot tests; `ci.yml` Android job + `android-package.yml` are the gate.)
- Desktop contract untouched → still green:
  ```bash
  npm run typecheck
  npm run lint
  npx vitest run apps/desktop/tests/main/companion/  # if present; else full: npx vitest run
  ```
  Full `npm run check` is authoritative for the JS tree (it ignores `apps/android/`); run it if time permits, at minimum typecheck+lint+related vitest.
- Manual acceptance (evidence only, via Fake repo or LAN-paired desktop, never the gate):
  ```bash
  adb shell am start -n com.foundry.companion.debug/com.foundry.companion.MainActivity  # + session-inject extras per apps/android/README.md
  ```
  Walk: pair → Runs → NewRun orchestrator accept → Run waiting strip → Answer Approve/Reject → Inspector tail → Smith (if kept) → Connection sheet Retry/Unpair; confirm offline banner copy ("Reconnecting to ⟨desktop name⟩…" / "Can't reach ⟨desktop name⟩…") and disabled mutating actions.

## 8. Files to touch (closed list; anything else needs an addendum)

- ADD/MODIFY Android impl: `.../data/model/CompanionTypes.kt`, `.../data/repository/CompanionRepository.kt`, `.../data/repository/HttpCompanionRepository.kt`, `.../data/repository/FakeCompanionRepository.kt` (locate via find), `.../viewmodel/CompanionViewModel.kt`, `.../ui/screens/newrun/NewRunScreen.kt` (or located NewRun path), `.../ui/screens/runs/RunsScreen.kt` (waiting chip), `.../ui/screens/rundetail/RunDetailScreen.kt` (strip), NEW `.../ui/screens/rundetail/AnswerInterruptSheet.kt` (or alongside Inspector components), `.../notification/*` (waiting notification), `.../util/ReasoningEfforts.kt` (read-only unless catalog shape changed).
- ADD/MODIFY Android tests: `apps/android/app/src/test/java/com/foundry/companion/**/*Test.kt` (repository + VM + Robolectric screenshots incl. `RunsScreenScreenshotTest.kt` siblings).
- READ-ONLY desktop reference: `apps/desktop/src/shared/companion.ts`, `apps/desktop/src/main/companion/host.ts`, `apps/desktop/src/shared/ipc-contract.ts`, `apps/desktop/src/shared/types.ts`, `apps/desktop/src/shared/direct-providers.ts`.
- SPEC (one-line-class edits): `specs/companion-android-ui.md` (§4 Smith line + §3.7 route names if desktop names differ from placeholders; §5 routes if accept flow adds one).
- DO NOT TOUCH: desktop renderer screens, `ipc-contract.ts` Bridge/provider/doctor routes, `electron-builder.yml`, `apps/website`, `resources/bridge`, `.github/workflows/*`, protocol version (unless 1.1 proves a bump).

## 9. Acceptance criteria

- [ ] §1 scope table recorded (last-Android commit, desktop commits since, route-by-route parity matrix, Smith KEEP/REMOVE choice, model + screenshot premise resolutions).
- [ ] Orchestrator accept is exactly-once via `POST .../accept` (no direct `POST /v1/runs` for orchestrated runs); list renders durable proposals; offline disables Accept.
- [ ] Interrupt: waiting chip + pinned strip with exact spec copy; Answer sheet with Approve/Reject + notes; dismiss ≠ answer; offline "Reconnect to answer"; high-priority notification even with settle toggle off.
- [ ] No desktop-mirror surfaces added; no model/effort removed; `muse-spark-1.3/xhigh` is a default, not a lock-in.
- [ ] Robolectric screenshot PNGs attached; `./gradlew :app:testDebugUnitTest` green on CI; JS typecheck/lint/companion vitest green.
- [ ] PR title `[android] ...` per `.github/pull_request_template.md`, `specs/run_260911_f7e94b-plan.md` linked, report checks run/skipped/failed.

## 10. Risks

- Placeholder interrupt route names in §3.2 may differ from `host.ts` — mitigated by 1.2 contract-first lookup; never ship a client-invented path.
- Smith KEEP vs spec §4 conflict — mitigated by one-line spec update (KEEP) instead of destructive delete.
- Single-model request tempts hardcoding — blocked by §6 + picker tests.
- Manual-screenshot gate tempts orb builds — blocked by §7 (CI job is the gate; PNGs are evidence only).
