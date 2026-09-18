# AGENTS.md — src/main/smith

Smith is the native operator agent. It exposes typed app capabilities. Normal mode requires approval for privileged app actions. The operator can enable YOLO mode for one chat.

## Sessions and scope

- `SmithService` owns one persistent chat per project and one global “All projects” chat.
- Project chats run in that checkout. Global chat runs in `<supportDir>/pi/smith/global/workspace` and has no checkout.
- Scope is `projectId?: string`; global tools require an explicit project ID for project-specific work.
- State stays under `<supportDir>/pi/smith/<scope>/`, never `~/.pi`.
- Unknown tools fail closed. Direct writes are limited to the current checkout or global workspace.

## Composition turns

- `compose/session.ts` owns `ComposeSession`: a bounded, read-only one-shot at the project checkout, with no worktree or write tools. Schema-bound `submit_result` output must pass composition rails within the envelope correction budget. Rails reject a path-bounded implementer followed by a project test command unless `writes` includes test/fixture globs or is unrestricted; later agent phases must consume an earlier envelope via `prompt.inputs`. Write-capable reviewers get a fix constitution, not "do not fix".
- `compose/model.ts` resolves chat, compose, and repair choices: explicit override → Smith → Agent Defaults → `inherit`. Effort follows the selected settings tier unless overridden. Composition and repair permit `inherit`; chat retains the transport's `requireModel` guard.
- `compose/proposals.ts` owns durable run proposals through `Tracer`, distinct from Smith's action `ProposalQueue`. Accept remains exactly-once through `accepted_run_id` and re-validates with `startRun(plan)`.
- `compose-tools.ts` is the in-process `smith_compose` tool for project and global Smith chats only, never run sessions. `compose`/`revise`/`get`/`list` are immediate; `accept`/`discard`/`cancel` stay approval-gated. It calls `ProposalStore` directly, not the IPC invoker. Soft cap: 3 generating rows per chat. An expired composition session refuses revision rather than replacing the row.
- `compose/after-start.ts` is the shared start path for the Runs composer IPC and `smith_compose` compose, including `warmStartPrep`.
- `compose/replan.ts` proposes pipeline repairs; the engine alone validates and applies them in the run's existing worktree.
- IPC names and progress channels use the `smith-compose:*` contract (migrated atomically); historical `ComposeState` rows map the retired `orchestrator` role to `smith` at the read boundary. Composition does not open a persistent chat.
- `run_plan` is main-minted from proposal transitions, never model-presentable. Only already-open project chats (and the issuing global chat) receive bounded, secret-checked snapshots. Renderer actions resolve the durable row; missing rows remain inert snapshots.

## Capabilities

- Entity reads execute immediately; validated entity create/edit operations use proposals.
- `smith_runs` `events` is one bounded page (count + JSON budget). Never dump a full run trace into the model; `detail` is the failure summary.
- Directing a live pipeline agent is `smith_runs` `agents` / `conversation` / `messages` to inspect, then approved `message_phase` or `interrupt_phase`. Direction never resumes, recasts, or bypasses gates. Conversation paging is pinned to that phase's recorded session, not the reused agent's current row.
- App operations use fixed enums mapped to fixed main handlers. Never accept an IPC channel from the model.
- Persistent, destructive, credential, process, Git/PR, lifecycle, network, and maintenance actions require an action proposal whose executor closes over one fixed handler.
- `SmithService.invoke` is a main-only handler registry, not renderer IPC.
- Readiness tools wrap the readiness subsystem; readiness remains durable outside the chat.

`smith_present` emits validated, bounded, secret-checked presentation artifacts directly into chat. The renderer owns visuals; never infer cards from Markdown. Adding a kind requires the shared union, main validation/emission, renderer registration/body, an explicit persistence decision, and tests.

`action_receipt` cannot be model-presented. Main mints it from the real proposal result. Approval is not success, and restored receipts are inert snapshots. Entity saves do not get receipts because the stored definition is their evidence.

## Approval and secrets

- `ProposalQueue` allows one pending entity/action proposal globally. Public data is clone-safe; executor closures remain in main.
- YOLO mode uses the same proposal executors, validation, and action receipts, but does not show approval cards for ordinary actions or entity saves. It does not change tool allowlists, write boundaries, or run gates.
- Only the renderer permission control can enable YOLO mode, and only while the chat is idle. Disabling it affects future proposals, not work already started. The mode belongs to the source chat, not an action's target project. It is never saved and resets on New chat or app restart.
- Secret requests and Companion pairing always use interactive cards. Automatic entity-save failures settle instead of waiting for an invisible retry card.
- Validate entities before showing the card. Entity save failures may retry; settled action failures clear the slot.
- API keys are accepted only as `SmithProposalAnswer.secret` for a matching `secretRequest`. Never place credentials in args, transcripts, model results, state JSON, artifacts, or logs.
- Companion pairing payloads remain renderer-only; Smith sees availability only.
- Every non-Smith invoke channel must have an immediate, approval, secure, or renderer-only capability classification.

## Validation

```bash
pnpm exec vitest run -t "smith"
pnpm exec vitest run apps/desktop/tests/main/smith/smith-capability-coverage.test.ts
```
