# AGENTS.md — src/main/smith

Smith is Foundry's native in-app operator agent. It has functional parity with
meaningful desktop operations while preserving explicit typed capabilities and
inline human approval.

## Scope and sessions

- `SmithService` owns one persistent chat per project and one global “All
  projects” chat. Project sessions run in that checkout; global runs in
  `<supportDir>/pi/smith/global/workspace` and has no checkout.
- Scope is `projectId?: string` across IPC and snapshots. Global tools require an
  explicit project ID for project-specific operations.
- Chat state stays under `<supportDir>/pi/smith/<scope>/`; never touch `~/.pi`.
- Unknown tools fail closed. Direct writes are permitted only inside the current
  project checkout or global workspace.

## Tools and privilege

- `smith_list`, `smith_show`, `smith_propose`: full entity reads and validated
  entity create/edit proposals.
- `smith_entities`, `smith_settings`, `smith_projects`, `smith_runs`,
  `smith_prs`, `smith_interrupts`, `smith_providers`, `smith_companion`, and
  `smith_system`: fixed operation enums over existing handlers.
- `smith_present` (`present-tools.ts`): agent-callable rich UI artifacts. Smith
  picks a registered kind and supplies typed entity data; the renderer owns the
  visuals. Artifacts are presentation only — validated (store rails), size- and
  secret-capped, emitted straight into the transcript, never on the proposal
  queue, and persisted with chat state (unsupported versions restore as a
  readable note). Adding an artifact kind takes exactly this path: the
  `SmithArtifact` union in `shared/types.ts`, validation/emission in
  `present-tools.ts`, renderer registration in
  `renderer/view-models/smith-artifact-view.ts` plus a design body in
  `renderer/components/smith/`, a persistence/restore decision in
  `chat-session.ts`, and tests in `smith-present-tools.test.ts` +
  `smith-artifact-view.test.ts`. Never infer cards from Smith's Markdown.
  Three kinds report live app state and keep the gates that own it:
  `engineer_checkpoint` shows a checkpoint's question, run/phase context, and
  editable answer but answers nothing — the write is `smith_interrupts answer`
  on the approval queue; `readiness_journey` reports the marker committed on
  the base ref as the only verdict, with criteria, remediation work, and PR as
  explanation; `provider_status` carries connection/auth/error metadata plus a
  `keyPresent` boolean and paired devices, and `validateProviderStatus`
  refuses any other key/token/pairing/QR field so the masked secret card and
  the renderer-only pairing payload stay out of the transcript.
  Four more report app state without any write path: `settings_diff` shows
  labelled old/new values for a settings change (the change itself is still a
  `smith_settings` action on the approval queue), `diagnostics` carries
  doctor/orphan/maintenance/update results, `data_table` presents bounded typed
  catalogs of entities, runs, or projects, and `evidence_disclosure` discloses
  context occupancy plus capped command/diff/prompt excerpts. Every one goes
  through the same `findSecretKey` boundary as the rest, so a credential-shaped
  field anywhere in the params is refused before a card exists.
- `action_receipt` (`receipts.ts`) is the one artifact kind the model may not
  present. It is minted by main on the proposal answer path — the queue reports
  every settled **action** through `ActionSettledHandler`, `SmithService` builds
  the receipt from the executor's real result and files it into the proposing
  conversation. Approval is not success: a failed or refused execution produces
  a failed receipt carrying the executor's words. A receipt holds a snapshot
  plus identifiers only — no executor, no handle, no retry — so one restored
  after a relaunch can be read but never re-run. `SmithPresentableArtifactKind`
  keeps it out of `smith_present`'s enum by type, not by convention. Entity
  saves get no receipt: their evidence is the stored definition.
- Readiness exposes its three conversational tools plus `readiness_manage`.
- Read-only operations invoke immediately. Persistent/destructive/credential,
  process, Git/PR, lifecycle, network, and maintenance actions enqueue an action
  proposal whose executor closes over exactly one fixed `IPC.*` handler.
- `SmithService.invoke` is attached to the main-only handler registry at startup.
  It is not renderer IPC. Never accept a channel argument or dispatch from
  `capability-coverage.ts`; that file is documentation enforced by tests.

## Approval and secrets

- `ProposalQueue` permits one pending entity/action proposal globally. Public
  proposal data is clone-safe; executor closures remain in main.
- Entity validation occurs before the card. Entity save failures are retryable;
  ordinary action failures clear/unblock so Smith can correct arguments.
- API keys are accepted only as `SmithProposalAnswer.secret` for a proposal with
  `secretRequest`. Never put a key/token/secret in proposal args, transcript,
  model result, chat-state JSON, or logs.
- Companion pairing payloads are renderer-only private displays. Smith receives
  availability only.

## Tests

```bash
npx vitest run -t "smith"
npx vitest run apps/desktop/tests/main/smith/smith-capability-coverage.test.ts
npx vitest run apps/desktop/tests/main/ipc/ipc-invoker.test.ts
```

The capability coverage test must fail whenever a non-Smith invoke channel is
added without one immediate/approval/secure/renderer-only classification.
