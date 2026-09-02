# AGENTS.md — src/main/smith

Smith is the native operator agent. It exposes typed app capabilities while keeping privileged actions behind explicit approval.

## Sessions and scope

- `SmithService` owns one persistent chat per project and one global “All projects” chat.
- Project chats run in that checkout. Global chat runs in `<supportDir>/pi/smith/global/workspace` and has no checkout.
- Scope is `projectId?: string`; global tools require an explicit project ID for project-specific work.
- State stays under `<supportDir>/pi/smith/<scope>/`, never `~/.pi`.
- Unknown tools fail closed. Direct writes are limited to the current checkout or global workspace.

## Capabilities

- Entity reads execute immediately; validated entity create/edit operations use proposals.
- App operations use fixed enums mapped to fixed main handlers. Never accept an IPC channel from the model.
- Persistent, destructive, credential, process, Git/PR, lifecycle, network, and maintenance actions require an action proposal whose executor closes over one fixed handler.
- `SmithService.invoke` is a main-only handler registry, not renderer IPC.
- Readiness tools wrap the readiness subsystem; readiness remains durable outside the chat.

`smith_present` emits validated, bounded, secret-checked presentation artifacts directly into chat. The renderer owns visuals; never infer cards from Markdown. Adding a kind requires the shared union, main validation/emission, renderer registration/body, an explicit persistence decision, and tests.

`action_receipt` cannot be model-presented. Main mints it from the real proposal result. Approval is not success, and restored receipts are inert snapshots. Entity saves do not get receipts because the stored definition is their evidence.

## Approval and secrets

- `ProposalQueue` allows one pending entity/action proposal globally. Public data is clone-safe; executor closures remain in main.
- Validate entities before showing the card. Entity save failures may retry; settled action failures clear the slot.
- API keys are accepted only as `SmithProposalAnswer.secret` for a matching `secretRequest`. Never place credentials in args, transcripts, model results, state JSON, artifacts, or logs.
- Companion pairing payloads remain renderer-only; Smith sees availability only.
- Every non-Smith invoke channel must have an immediate, approval, secure, or renderer-only capability classification.

## Validation

```bash
npx vitest run -t "smith"
npx vitest run apps/desktop/tests/main/smith/smith-capability-coverage.test.ts
```
