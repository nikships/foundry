# Plan: Give Smith functional parity with the Foundry operator

## Goal

Close the capability gaps identified in the survey so Smith can perform the same meaningful application operations exposed to the desktop user: manage configuration and projects, mutate all entity types, run and settle pipelines, manage pull requests and interrupts, configure providers, operate Companion, and run diagnostics/maintenance/update actions.

“Parity” in this plan is **functional parity, not silent autonomy**:

- Read-only operations execute immediately.
- Persistent, destructive, credential-bearing, shell/process, Git/PR, run-lifecycle, and app-lifecycle operations go through Smith’s inline human approval card before the existing main-process handler is called.
- Smith may initiate provider OAuth and may ask for an API key, but secret values are entered into a masked approval-card field and are never placed in the model prompt, proposal payload, transcript, persisted chat state, logs, or tool result.
- Companion pairing secrets are rendered to the operator as a QR/private result in the approval card and are never returned to the model.
- The renderer remains unprivileged, unknown Smith operations fail closed, and Smith does not receive a generic IPC channel escape hatch.

This intentionally replaces the old “projects/settings/runs are operator-only” invariant while preserving the useful safety properties: explicit typed operations, one pending approval at a time, store validation, no secret disclosure, and reuse of the exact application handlers used by the UI.

## Acceptance criteria

1. Every meaningful non-Smith method in `FoundryApi` is classified in code as one of:
   - immediate Smith read,
   - approval-gated Smith action,
   - secure approval/private display,
   - or a documented renderer-only plumbing primitive with an equivalent Smith flow.
2. A parity test fails whenever a new non-Smith IPC invoke channel is added without a Smith coverage entry.
3. Smith can operate in either a selected-project session or an “All projects” global session. Project-scoped sessions retain direct checkout tools; the global session has no project checkout and uses explicit project IDs for project-specific operations.
4. Smith can fully inspect projects rather than receiving the old `{id,name,path}` projection.
5. Smith can rename, duplicate, reset, and remove agents/pipelines/envelopes, and can perform project/settings/run/PR/interrupt/provider/Companion/maintenance/updater actions through the approval gate.
6. Approved Smith actions call the same handler functions as renderer IPC calls; business logic is not copied into Smith tool modules.
7. API keys and Companion pairing secrets never appear in a `SmithProposal`, `SmithChatState`, transcript row, persisted `chat-state.json`, or model-visible tool result.
8. Existing entity validation-before-card behavior and one-pending-proposal behavior remain covered by tests.
9. Existing renderer IPC channels remain unchanged in count and meaning; this work changes Smith argument/result types but does not add a generic renderer invoke channel.

## Architecture

### 1. Reuse the existing IPC handlers in process

Refactor IPC registration so the domain routers are collected into a main-process-only handler registry before Electron registers them. The registry exposes a typed `MainInvoker` that can call a known handler by its existing `IPC.*` constant. `registerIpc()` uses that registry for Electron, and returns the invoker so `SmithService` can use the same implementation.

This is not exposed through preload and is not handed directly to the model. Smith tool modules map fixed operation enums to fixed channels and argument order; an operation string supplied by the model can never become an arbitrary channel string.

### 2. Generalize the proposal queue

Change the queue from “save one entity” to “approve one typed proposal and run its main-only executor closure.” The public proposal remains structured-clone-safe. The pending queue entry may additionally hold an executor function that never crosses IPC.

Use a discriminated union:

- `SmithEntityProposal`: current create/edit payload for agent/pipeline/envelope.
- `SmithActionProposal`: operation ID, human title/summary, redacted arguments, risk classification, source scope, optional masked secret request, and optional private-display result kind.

The queue executor returns a model-visible result separately from an optional renderer-only private display. Entity save failures may remain pending/retryable as today; ordinary action failures clear the proposal and unblock the tool with `{ok:false,error}` so Smith can correct its arguments and propose again.

### 3. Add domain tools rather than a generic channel tool

Keep `smith_list`, `smith_show`, `smith_propose`, and the readiness tools, and add domain tools whose schemas enumerate allowed operations. Each tool validates required fields, resolves a default project from the current session when allowed, and either invokes a read immediately or raises a typed action proposal.

### 4. Add a global Smith session

Represent Smith scope as `projectId?: string` across the typed seam. A project session uses the project checkout as `cwd`; the global session uses `<supportDir>/pi/smith/global/workspace` and receives a scope prompt that explicitly says it has no checkout. Both the dedicated screen and bubble use the same selected Smith scope.

## Capability/tool matrix

The operation names below are the exact enums to expose in tool schemas.

### Existing entity tools

Update `smith_list` / `smith_show` / `smith_propose`:

- `smith_list(kind, projectId?)`: `agent | pipeline | envelope | project`; projects return full `ProjectDef` objects.
- `smith_show(kind, name, projectId?)`: projects are showable by project ID; project sessions default `projectId` for scoped agent/pipeline reads, while global sessions require an explicit project ID when a project-local scope is intended.
- `smith_propose(kind, mode, spec, projectId?)`: preserve create/edit validation-before-card for agents/pipelines/envelopes; permit global roster/pipeline writes by omitting `projectId` and project-local writes by supplying it.

Add `smith_entities` with these operations:

| Operation | Arguments | Execution |
| --- | --- | --- |
| `agent_stale` | `projectId?` | immediate `rosterStaleBuiltins` |
| `agent_validate` | `agent` | immediate `rosterValidate` |
| `agent_preview` | `agent` | immediate `rosterPreview` |
| `agent_rename` | `from`, `to`, `projectId?` | approval → `rosterRename` |
| `agent_remove` | `name`, `projectId?` | destructive approval → `rosterRemove` |
| `agent_duplicate` | `name`, `projectId?` | approval → `rosterDuplicate` |
| `agent_reset` | `name`, `projectId?` | destructive approval → `rosterReset` |
| `agent_upload_mark` | `filePath` | approval; read the file in main, infer MIME, base64 it, then invoke `rosterUploadMark` |
| `agent_remove_mark` | `emblem` | destructive approval → `rosterRemoveMark` |
| `envelope_usage` | `name` | immediate `envelopesUsage` |
| `envelope_validate` | `definition` | immediate `envelopesValidate` |
| `envelope_preview` | `name` | immediate `envelopesPreview` |
| `envelope_remove` | `name` | destructive approval → `envelopesRemove` |
| `envelope_duplicate` | `name` | approval → `envelopesDuplicate` |
| `pipeline_stale` | `projectId?` | immediate `pipelinesStaleBuiltins` |
| `pipeline_validate` | `pipeline`, `projectId?` | immediate `pipelinesValidate` |
| `pipeline_dry_run` | `pipelineId`, `projectId`, `request` | immediate `pipelinesDryRun` |
| `pipeline_remove` | `id`, `projectId?` | destructive approval → `pipelinesRemove` |
| `pipeline_duplicate` | `id`, `projectId?` | approval → `pipelinesDuplicate` |
| `pipeline_reset` | `id`, `projectId?` | destructive approval → `pipelinesReset` |

`agent_upload_mark` is the equivalent flow for the renderer’s raw-byte upload API: Smith supplies a file path, but bytes never enter model-visible JSON.

### `smith_settings`

| Operation | Arguments | Execution |
| --- | --- | --- |
| `get` | none | immediate `settingsGet` |
| `patch` | `patch: Partial<AppSettings>` | approval → `settingsPatch` |
| `catalog_gates` | none | immediate `catalogGates` |
| `catalog_template_variables` | none | immediate `catalogTemplateVariables` |
| `catalog_models` | none | immediate `catalogAgentModels` |

The patch operation accepts the same fields as `AppSettings`; the existing `SettingsStore.patch()` remains the validator.

### `smith_projects`

| Operation | Arguments | Execution |
| --- | --- | --- |
| `list` | none | immediate `projectsList` |
| `show` | `projectId` | immediate list + exact ID lookup |
| `add` | none | approval → `projectsAdd` (opens the same folder picker) |
| `github_account` | none | immediate `projectsGithubAccount` |
| `choose_parent` | none | approval → `projectsChooseParentDir` |
| `create_github` | `input: NewRepoInput` | external/write approval → `projectsCreateGithub` |
| `save` | `project: ProjectDef` | approval → `projectsSave` |
| `remove` | `projectId` | destructive approval → `projectsRemove` |
| `export` | `projectId` | write approval → `projectsExport` |
| `try_command` | `projectId`, `argv` | shell approval → `projectsTryCommand` |
| `sniff_commands` | `projectId` | shell approval because candidates are executed → `projectsSniffCommands` |
| `ask_commands` | `projectId` | model/process approval → `projectsAskAgentCommands` |
| `cancel_detection` | `detectionId` | approval → `projectsCancelDetection` |
| `detection` | `detectionId` | immediate `projectsDetection` |
| `setup_get` | `projectId` | immediate `projectsSetupScriptGet` |
| `setup_save` | `projectId`, `script` | approval → `projectsSetupScriptSave` |
| `setup_sniff` | `projectId` | immediate `projectsSetupScriptSniff` |
| `setup_try` | `projectId`, `script` | shell approval → `projectsSetupScriptTry` |
| `setup_ask` | `projectId` | model/process approval → `projectsSetupScriptAskAgent` |
| `setup_progress` | `setupId` | immediate `projectsSetupProgress` |
| `setup_cancel` | `setupId` | approval → `projectsSetupCancel` |
| `check` | `projectId` | immediate `projectsCheck` |
| `reveal` | `path` | external-UI approval → `projectsReveal` |
| `scope_copies` | `projectId` | immediate `projectsScopeCopies` |
| `base_inspect` | `projectId` | immediate `projectsBaseSyncInspect` |
| `base_sync` | `projectId` | Git approval → `projectsBaseSync` |

### Readiness tools

Keep the three current names, but give state-changing paths approval executors:

- `readiness_check`: immediate static/base-ref read.
- `readiness_remediate`: approval first, then call the existing `ReadinessSession.makeReady()` closure so progress continues to stream into the Smith transcript.
- `readiness_pr_status`: inspect immediately; if confirmation/finalization would mutate local state, raise approval before calling `confirmMerge()`.

Add `readiness_manage`:

| Operation | Arguments | Execution |
| --- | --- | --- |
| `inspect` | `projectId?` | immediate `readinessInspect` |
| `evaluate` | `projectId?`, optional model/effort/save-default options | approval → `readinessEvaluate` |
| `state` | `projectId?` | immediate `readinessGet` |
| `cancel` | `projectId?` | approval → `readinessCancel` |
| `skip` | `projectId?` | approval → `readinessSkip` |
| `retry` | `projectId?` | approval → `readinessRetry` |
| `confirm_merge` | `projectId?` | Git approval → `readinessConfirmMerge` |
| `dismiss` | `projectId?` | approval → `readinessDismiss` |

Project-scoped readiness tools default to the session project. Global scope requires `projectId`.

### `smith_runs`

| Operation | Arguments | Execution |
| --- | --- | --- |
| `list` | `projectId?`, `includeArchived?` | immediate `runsList` |
| `detail` | `projectId?`, `runId` | immediate `runsDetail` |
| `events` | `projectId?`, `runId`, `afterChangeId` | immediate `runsEvents` |
| `live_tail` | `phaseId` | immediate `runsLiveTail` |
| `context` | `projectId?`, `runId`, `agent` | immediate `runsContextBreakdown` |
| `prompt` | `projectId?`, `phaseId` | immediate `runsPrompt` |
| `start` | `projectId?`, `pipelineId`, `request` | lifecycle approval → `runsStart` |
| `resume` | `projectId?`, `runId` | lifecycle approval → `runsResume` |
| `kill` | `projectId?`, `runId` | destructive approval → `runsKill` |
| `archive` | `projectId?`, `runId`, `archived` | approval → `runsArchive` |
| `merge` | `projectId?`, `runId` | Git approval → `runsMergeWorktree` |
| `fix_merge` | `projectId?`, `runId` | model/Git approval → `runsFixMerge` |
| `discard` | `projectId?`, `runId` | destructive approval → `runsDiscardWorktree` |
| `open_worktree` | `projectId?`, `runId` | external-UI approval → `runsOpenWorktree` |
| `reveal_files` | `projectId?`, `runId` | external-UI approval → `runsRevealFiles` |

### `smith_prs`

| Operation | Arguments | Execution |
| --- | --- | --- |
| `status` | `projectId?` | immediate `prsStatus` |
| `list` | `projectId?` | immediate `prsList` |
| `create` | `projectId?`, `runId`, `title`, `body` | external/Git approval → `prsCreate` |
| `merge` | `projectId?`, `prNumber`, `method` | destructive external/Git approval → `prsMerge` |
| `fix_conflicts` | `projectId?`, `prNumber` | model/Git approval → `prsFixConflicts` |

### `smith_interrupts`

- `list`: immediate `interruptsList`.
- `answer(interruptId, decision, text?)`: approval → `interruptsAnswer`.

The approval card must show the interrupt ID, run ID/title when available, decision, and edited text before the engine receives it.

### `smith_providers`

| Operation | Arguments | Execution |
| --- | --- | --- |
| `state` | none | immediate `bridgeState` |
| `stored_keys` | none | immediate `bridgeStoredKeys` |
| `connect` | `provider` | external approval → `bridgeConnect` |
| `disconnect` | `provider` | destructive credential approval → `bridgeDisconnect` |
| `cancel_login` | `provider` | approval → `bridgeCancelLogin` |
| `set_api_key` | `providerId` only | secure approval; card collects masked key, executor calls `bridgeSetApiKey` |
| `clear_api_key` | `providerId` | destructive credential approval → `bridgeClearApiKey` |

Never accept an API key in the tool arguments. Reject any unexpected `apiKey`, `key`, `token`, or `secret` field before raising a proposal.

### `smith_companion`

| Operation | Arguments | Execution |
| --- | --- | --- |
| `state` | none | immediate `companionState` |
| `start` | none | network approval → `companionStart` |
| `stop` | none | network approval → `companionStop` |
| `pairing` | `refresh?` | secure approval → `companionPairingPayload`; tool gets only `{ok,available}`, renderer gets private QR payload |
| `unpair` | `deviceId` | destructive credential approval → `companionUnpair` |

### `smith_system`

| Operation | Arguments | Execution |
| --- | --- | --- |
| `doctor` | none | immediate `doctorRun` |
| `orphans` | none | immediate `maintenanceOrphans` |
| `remove_orphan` | `projectId`, `path` | destructive approval → `maintenanceRemoveWorktree` |
| `apply_retention` | none | destructive approval → `maintenanceRetention` |
| `compact` | none | maintenance approval → `maintenanceCompact` |
| `version` | none | immediate `appVersion` |
| `open_external` | `url` | external-UI approval → `appOpenExternal` |
| `quit` | none | app-lifecycle approval → `appQuit` |
| `relaunch` | none | app-lifecycle approval → `appRelaunch` |
| `update_status` | none | immediate `updaterGetStatus` |
| `update_check` | none | network approval → `updaterCheck` |
| `update_download` | none | network/write approval → `updaterDownload` |
| `update_install` | none | app-lifecycle approval → `updaterQuitAndInstall` |

`appAssetUrl` is the sole invoke channel classified as renderer-only plumbing: it translates packaged asset paths and has no operator intent to reproduce. Event subscriptions and menu navigation are likewise renderer plumbing rather than privileged application actions.

## File-by-file implementation plan

### A. Shared types and IPC contract

1. **`apps/desktop/src/shared/types.ts`**
   - Replace the single `SmithProposal` interface with `SmithEntityProposal | SmithActionProposal` plus a shared base.
   - Add exact types for `SmithActionRisk`, `SmithSecretRequest`, `SmithPrivateDisplay` (initially Companion pairing), `SmithProposalAnswer`, `SmithProposalAnswerResult`, and model-visible proposal execution outcomes.
   - Keep entity fields (`kind`, `mode`, `name`, `spec`, `validation`, `overwrites`) on the entity branch so existing entity rendering and tests can type-narrow cleanly.
   - Put redacted `args`, `operation`, `title`, `summary`, `risk`, and optional `secretRequest` on the action branch. Do not put secret values on either branch.
   - Change proposal source scope from mandatory `projectId: string` to optional `projectId?: string`.

2. **`apps/desktop/src/shared/ipc-contract.ts`**
   - Change `SmithChatState.projectId` and every `FoundryApi.smith` scope argument to `string | undefined`.
   - Change `answerProposal` to return `Promise<SmithProposalAnswerResult>` instead of `boolean`.
   - Document that `SmithProposalAnswer.secret` is accepted only for a proposal declaring `secretRequest`, is main-process-only after IPC receipt, and must never be echoed.
   - Do not add new IPC channels; all app actions use the existing domain channels through the main-only invoker.

3. **`apps/desktop/src/preload/bridge.ts`**
   - Update the Smith wrapper signatures/result typing to match the optional scope and structured answer result. Keep the named-channel-only bridge unchanged.

4. **`apps/desktop/src/renderer/api.ts`** and **`apps/desktop/src/renderer/mockFoundry.ts`**
   - Keep the guarded API in sync with the contract.
   - Teach the mock Smith implementation to maintain separate global/project snapshots and to return a structured proposal answer result.
   - Ensure mock proposals/private displays contain no secret in model-visible state.

### B. Reusable main-process handler registry

5. **`apps/desktop/src/main/ipc/shared.ts`**
   - Add `MainHandler`, `MainHandlerRegistry`, and `MainInvoker` types.
   - Add a registry implementation that rejects duplicate channels and rejects unknown invokes.

6. **`apps/desktop/src/main/ipc/index.ts`**
   - Split collection from Electron registration: `collectIpcHandlers(ctx)` calls every current router with a collecting `Handle`; `registerIpc(ctx)` registers those collected functions with `ipcMain.handle` and returns a `MainInvoker` that awaits sync or async handlers uniformly.
   - Preserve exactly-once registration and the current channel set.
   - Do not expose the registry to preload or renderer.

7. **`apps/desktop/src/main/main.ts`**
   - Capture the invoker returned by `registerIpc(ctx)` and immediately call `ctx.smith.attachInvoker(invoker)` before opening the first window.

8. **`apps/desktop/src/main/ipc/AGENTS.md`**
   - Document the main-only registry/invoker, why it does not widen the renderer surface, and the rule that Smith tool modules must map fixed operations to fixed channels rather than accept a channel argument.

### C. General approval infrastructure

9. **`apps/desktop/src/main/smith/proposals.ts`**
   - Generalize `ProposalInput` and pending entries for entity/action proposals.
   - Let `propose(input, executor?)` retain a main-only executor closure. Default entity proposals use the injected entity-save executor; action tools always provide their own fixed executor.
   - Pass the answer (including an optional secret) only to the executor, never into the public proposal.
   - Return structured answer errors to the renderer. Support `{retryable:true}` failures for entity save behavior and non-retryable failures that clear/unblock action proposals.
   - Split executor output into `modelResult` and optional `privateDisplay`; resolve the blocked tool only with `modelResult`.
   - Keep one pending proposal globally, `proposal_pending`, rejection/no-note behavior, and `cancelAll()`.

10. **`apps/desktop/src/main/smith/index.ts`**
    - Add `attachInvoker()` and a guarded `invoke()` method that errors if startup wiring is incomplete.
    - Update E2E proposal seed parsing for the proposal union while keeping malformed fixtures non-fatal.
    - Keep entity save injection in `SmithServiceDeps`; use the attached invoker only for fixed app operations.

11. **`apps/desktop/src/main/ipc/smith.ts`**
    - Return `SmithProposalAnswerResult` from `smithAnswerProposal`.
    - Keep `saveProposal()` for entity proposals only and reject an action proposal defensively if it reaches that path.
    - Update optional project scope handling.

### D. Tool helpers, parity manifest, and domain tools

12. **Create `apps/desktop/src/main/smith/tool-helpers.ts`**
    - Centralize JSON tool responses, field parsing, operation parsing, default-project resolution, `MainInvoker` execution, proposal construction, result normalization, and secret-field rejection.
    - `resolveProjectId(explicit, sessionScope, required)` must default from a project session and return a JSON error in global scope when required.

13. **Create `apps/desktop/src/main/smith/capability-coverage.ts`**
    - Export the complete mapping from every non-Smith invoke channel to `{tool, operation, mode}`.
    - Include explicit entries for equivalent/secure flows (`rosterUploadMark`, `bridgeSetApiKey`, `companionPairingPayload`) and the sole renderer-only exclusion (`appAssetUrl`).
    - Export a helper used only by tests to enumerate uncovered invoke channels. The runtime must not dispatch from this documentation map.

14. **Modify `apps/desktop/src/main/smith/entity-tools.ts`**
    - Remove project projection/list-only gates.
    - Accept optional target project IDs and full project show.
    - Preserve pre-card validation for entity create/edit.
    - Export the expanded tool-name list including `smith_entities`, or move the new operation tool into its own `entity-action-tools.ts` if needed to keep this file readable; if split, register both from `context.ts`.

15. **Create these tool modules under `apps/desktop/src/main/smith/`:**
    - `settings-tools.ts` → `smith_settings`
    - `project-tools.ts` → `smith_projects`
    - `run-tools.ts` → `smith_runs`
    - `pr-tools.ts` → `smith_prs`
    - `interrupt-tools.ts` → `smith_interrupts`
    - `provider-tools.ts` → `smith_providers`
    - `companion-tools.ts` → `smith_companion`
    - `system-tools.ts` → `smith_system`
   
   For each module:
   - Export a constant operation enum/list, dependency interface, single tool factory, and aggregate factory if useful.
   - Put the exact operation names and argument signatures from the matrix into the tool description and JSON schema.
   - Validate the operation and required fields in `execute`; do not rely only on the runtime schema.
   - Call read channels immediately through the injected `MainInvoker`.
   - For actions, enqueue a redacted `SmithActionProposal` with a closure that calls exactly one fixed channel (or the documented upload/secure adapter).
   - Return `{ok:false,error}` rather than throw for user-correctable arguments or handler failures.

16. **`apps/desktop/src/main/smith/readiness-tools.ts`**
    - Inject `ProposalQueue` and source scope.
    - Put remediation and state-mutating management operations behind action proposals while preserving the existing `ReadinessSession` closure and progress forwarding.
    - Add `readiness_manage` with the exact operations above.

17. **`apps/desktop/src/main/context.ts`**
    - Register every new tool factory on every Smith session.
    - Pass `this.smith.invoke` through a narrow callback; tool modules must not import `AppContext`.
    - Register project-only readiness tools only when the session has a project, while `readiness_manage` may target explicit projects from global scope through the invoker.
    - Change `createChat` to support the global session workspace and state directory.

### E. Global/project session scope and prompt

18. **`apps/desktop/src/main/smith/chat-session.ts`**
    - Replace mandatory project-only factory context with a discriminated `SmithScope` (`global` or `project` with ID/path).
    - Persist and broadcast optional `projectId` in snapshots.
    - Continue allowing direct checkout writes only in project scope. The global session’s `cwd` is its support-dir workspace, not any repository.
    - Pass a scope-specific standing prompt at session creation.

19. **`apps/desktop/src/main/smith/system-prompt.ts`**
    - Replace “scoped to one project” and the operator-only prohibition with the new functional-parity contract.
    - Explain immediate reads versus approval-gated actions, explicit project IDs in global scope, secure API-key/pairing handling, and terminal actions that may close/relaunch the app before Smith can answer.
    - Add `scopeContextBlock(scope)` and keep `screenContextBlock()` compact/per-turn.
    - Retain entity schemas and the “do not claim success until the tool result says so” rule.

20. **`apps/desktop/src/main/smith/AGENTS.md`**
    - Rewrite the tool inventory, project/global scope rules, approval union, secure-secret invariants, main-only invoker, and parity test requirement.
    - Remove the old project-read-only and lifecycle-operator-only invariants.

### F. Renderer approval UX and shared scope selection

21. **`apps/desktop/src/renderer/stores/app.tsx`**
    - Add `smithProjectId: string | null` and `selectSmithProject(id: string | null)` to shared app state so the bubble and full screen always show the same conversation.
    - Initialize from `foundry.smithProject`; validate it during `refreshAll`; default to the selected project, or global when there are no projects.
    - When the user explicitly selects a different app project, also set Smith to that project; the Smith scope picker can then switch back to “All projects.”

22. **Create `apps/desktop/src/renderer/components/smith/SmithScopePicker.tsx`**
    - Render “All projects” plus every project, with full path in option/title copy.
    - Disable switching while the current Smith turn is running or while a proposal from that scope is pending.
    - Use the same component in `SmithScreen` and `SmithBubble` so the two views cannot drift.

23. **`apps/desktop/src/renderer/hooks/useSmithChat.ts`**
    - Accept `string | undefined`, subscribe/filter on optional project IDs, and support the global snapshot.

24. **`apps/desktop/src/renderer/screens/SmithScreen.tsx`**, **`apps/desktop/src/renderer/components/smith/SmithBubble.tsx`**, and their CSS modules
    - Replace the fixed project chip with `SmithScopePicker`.
    - Enable chat with no projects by using global scope instead of disabling the composer.
    - Update empty/placeholder copy to describe global app management and project-scoped repository work.

25. **`apps/desktop/src/renderer/components/smith/SmithProposalCard.tsx`** and **`SmithProposalCard.module.css`**
    - Type-narrow entity versus action proposals.
    - Preserve the entity JSON/warning/overwrite UI.
    - For actions, show risk badge, exact operation title/summary, redacted arguments, source scope, and an approval button label appropriate to the action.
    - Render a password input only when `secretRequest` is present; never put its value into React props outside the card, proposal refresh state, error strings, or callbacks. Clear it on proposal change, reject, success, and unmount.
    - Use the structured `answerProposal` result to show exact executor errors.
    - Render a returned Companion `privateDisplay` with `components/media/QrCode.tsx`; keep it in local component state only, provide copy/refresh/dismiss controls, and never append it to the transcript.
    - Call the host completion callback after any successful action so app state refreshes; only entity proposals deep-link to Design.

26. **`apps/desktop/src/renderer/App.tsx`**
    - Replace `onSmithApproved` with a generic completion handler: `refreshAll()`/`refreshScoped()` after any approved action, and preserve Design deep-linking only for successful entity proposals.

### G. Documentation/spec amendment

27. **`specs/smith-v2-in-app-chat.md`**
    - Add a dated “capability parity amendment” that supersedes the project-list-only/operator-only sections.
    - Record the retained approval gate, global scope, handler reuse, and secret/private-display exceptions so the implementation no longer contradicts its owning spec.

28. **`apps/desktop/src/renderer/AGENTS.md`** and **`apps/desktop/src/shared/AGENTS.md`**
    - Document optional/global Smith scope, generalized proposal rendering, and the rule that secret answers/private displays never enter shared chat state.

## Tests

### Main/IPC tests

1. **Modify `apps/desktop/tests/main/ipc/ipc-surface.test.ts`**
   - Keep the exact 120-channel assertion.
   - Assert collection and Electron registration use the same handler set, every channel registers once, and no main-only invoker is exposed through preload.

2. **Add `apps/desktop/tests/main/ipc/ipc-invoker.test.ts`**
   - Prove direct in-process invocation calls the same collected handler as Electron registration, awaits sync/async results, rejects unknown channels, and rejects duplicate router registration.

3. **Modify `apps/desktop/tests/main/ipc/smith-router.test.ts`**
   - Cover optional/global scope and structured proposal-answer results, including secret forwarding only to the queue.

### Proposal/session tests

4. **Modify `apps/desktop/tests/main/smith/smith-proposals.test.ts`**
   - Cover entity and action proposal shapes, executor closures, redaction, secure answer handling, private display separation, non-retryable action failures, retryable entity failures, rejection, concurrency, and shutdown.
   - Explicitly assert a supplied API key is absent from `queue.list()`, model outcome, and serialized proposal JSON.

5. **Modify `apps/desktop/tests/main/smith/smith-service.test.ts`**
   - Cover invoker attachment, pre-attachment failure, one session per global/project scope, and proposal seed parsing for both branches.

6. **Modify `apps/desktop/tests/main/smith/smith-chat-session.test.ts`**
   - Cover global cwd/state persistence, project cwd behavior, scope-specific prompt text, optional project ID snapshots, and unchanged fail-closed custom-tool policy.

### Tool tests

7. **Modify `apps/desktop/tests/main/smith/smith-entity-tools.test.ts`**
   - Replace project projection/refusal assertions with full list/show assertions.
   - Add explicit target-scope tests and all entity action operation mappings.
   - Retain validation-before-card and overwrite tests.

8. **Add `apps/desktop/tests/main/smith/smith-capability-coverage.test.ts`**
   - Derive every invoke channel from `IPC`, exclude Smith lifecycle channels and renderer-only `appAssetUrl`, and assert exactly one coverage classification for each remaining channel.
   - Assert no tool operation maps to a `smith:*` channel and no runtime operation accepts a raw channel.

9. **Add domain executor tests:**
   - `smith-project-tools.test.ts`
   - `smith-run-pr-tools.test.ts`
   - `smith-settings-entity-tools.test.ts` (only if entity action tests are split out)
   - `smith-provider-companion-tools.test.ts`
   - `smith-system-interrupt-tools.test.ts`
   
   For every operation in each exported enum, assert its required arguments, immediate-vs-proposal behavior, exact `IPC.*` channel and argument order, default project resolution, global-scope missing-project error, and normalized result.

10. **Modify `apps/desktop/tests/main/smith/smith-readiness-tools.test.ts`**
    - Cover approval before remediation/finalization, continued progress forwarding after approval, and every `readiness_manage` channel mapping.

11. **Modify `apps/desktop/tests/main/smith/smith-system-prompt.test.ts`**
    - Remove old project/read-only lane assertions.
    - Assert global/project scope language, approval rules, secret rules, explicit project targeting, and terminal-action caveat.

### Renderer/E2E tests

12. **Add `apps/desktop/tests/renderer/smith-scope.test.ts`**
    - Test scope selection/defaulting as pure state/view-model helpers (Vitest runs without jsdom).

13. **Modify `apps/desktop/tests/e2e/seed.ts`**
    - Allow seeding either an entity proposal or an action proposal without a model.

14. **Modify `apps/desktop/tests/e2e/smith.spec.ts`**
    - Keep the existing entity-card smoke.
    - Add a global-scope switch assertion.
    - Add an action-card smoke showing risk/arguments.
    - Add a secure API-key proposal smoke: masked input is present, the key never appears in card JSON/transcript text, and reject clears it.
    - Add a Companion private-display fixture if it can be seeded without opening a LAN listener; otherwise cover private display in proposal unit tests and assert the QR component path with a renderer view-model test.

## Verification commands

Run focused tests first:

```bash
npx vitest run apps/desktop/tests/main/ipc/ipc-invoker.test.ts
npx vitest run apps/desktop/tests/main/ipc/ipc-surface.test.ts
npx vitest run apps/desktop/tests/main/ipc/smith-router.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-proposals.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-capability-coverage.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-entity-tools.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-project-tools.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-run-pr-tools.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-provider-companion-tools.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-system-interrupt-tools.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-readiness-tools.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-chat-session.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-system-prompt.test.ts
```

Then run repository gates:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run knip
npm test
npm run build
npm run check:css
npm run check:docs
```

Finally run the Electron smoke when the local environment supports it:

```bash
npx playwright test apps/desktop/tests/e2e/smith.spec.ts
```

## Manual verification checklist

1. With a project selected, ask Smith to inspect a run and verify reads return without a card.
2. Ask Smith to start a run; verify the card names project/pipeline/request, reject does nothing, and approve creates the run shown in Runs.
3. Ask Smith to rename/remove/duplicate/reset each entity kind and verify the same store behavior as the corresponding UI controls.
4. Switch Smith to “All projects,” remove all projects if needed, and verify chat remains enabled; project-dependent operations require an explicit ID.
5. Ask Smith to edit settings/project config and verify the app refreshes after approval.
6. Ask Smith to create/merge/fix a PR and verify the existing `gh` result is returned verbatim.
7. Ask Smith to answer an engineer interrupt; verify the proposed decision/text is shown before approval.
8. Ask Smith to connect/disconnect a provider and set/clear a key. Enter the key only in the masked card and inspect transcript/state files to confirm it is absent.
9. Ask Smith to show Companion pairing. Verify the QR is visible to the operator but Smith’s tool result contains no origin/secret payload.
10. Ask Smith to run doctor, inspect/remove an orphan, apply retention, compact traces, check/download an update, and relaunch; verify every mutating/lifecycle action is gated.
11. Confirm a malformed/unknown operation produces a JSON error and never calls the main invoker or raises a proposal.
