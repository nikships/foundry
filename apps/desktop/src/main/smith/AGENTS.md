# AGENTS.md — src/main/smith

Smith is Foundry's entity-smith: a native in-app chat on the bundled pi runtime
that creates and edits Foundry's own entities (agents, pipelines, envelopes)
with every write gated on human approval.

**The agent lives here.** `SmithChatSession` holds one multi-turn conversation
per project behind the vendor-neutral `AgentTransport` seam. A dedicated screen
and a Fin-style bubble are two views of that same session. `SmithService`
(`index.ts`) owns the sessions plus the one-slot `ProposalQueue` and is owned
by `AppContext`, started once at boot.

This is not a run. There are no tracer rows, no `foundry/<runId>` branch, and
no zero-interrupt policy: the operator is present, ordinary edits land in the
project checkout, and git is the undo. Entity writes still gate on the card.

## Project Overview

- **Chat**: `chat-session.ts` is one persistent conversation per project. Lazy
  open on the first message, file-backed under `<supportDir>/pi/smith/<projectId>/`
  (never `~/.pi`). "New chat" disposes and starts fresh. A mid-conversation
  model switch opens a successor session over the same history file.
- **Entity tools**: `entity-tools.ts` is the in-process successor to the old
  socket protocol. `smith_list` / `smith_show` answer from the stores;
  `smith_propose` validates through the store's own `validate()` **first**, then
  blocks on the proposal queue until the inline card is answered.
- **Readiness tools**: `readiness-tools.ts` wraps the existing readiness
  machinery (`evaluate.ts`, `readMarkerAtBaseRef()`, `ReadinessSession`) so the
  chat can check, remediate, and confirm the PR. Remediation stays on
  `foundry-ready/<id>`; `needs_continue` lives on the readiness session, outside
  the chat, so "New chat" never loses a half-done onboarding.
- **Persona**: `system-prompt.ts` is the standing harness (persona + entity
  schemas). Per-turn screen context is appended as standing context, never
  stuffed into the user message.
- **Approval**: `proposals.ts` is a one-slot queue. A valid `smith_propose`
  blocks the tool call until a human answers the card in the transcript.

## Setup Commands

```bash
npm ci
npm run build
```

There is no helper binary and no socket. Exercising the chat needs the app
running and a signed-in provider (Settings → Providers):

```bash
npm run dev
```

A cold Smith with no reachable model points at Settings → Providers.

## Development Workflow

- Adding an entity tool: extend `entity-tools.ts`, register it from the
  factory `context.ts` already installs on each `SmithChatSession`, and pin
  the contract in `apps/desktop/tests/main/smith/smith-entity-tools.test.ts`.
  The store's `validate()` is the enforcement; the harness only has to be
  roughly right.
- Adding a readiness tool: wrap existing `readiness/` code in
  `readiness-tools.ts`. Do not reimplement marker/worktree/merge rules here.
- Read ops answer straight from the stores, scope-aware. Write ops validate
  **first**: errors return as JSON and never raise a card; warnings ride along
  on the card.
- The queue never imports a store. `context.ts` injects `saveProposal` from
  `src/main/ipc/smith.ts` as the `SaveHandler`, which is also what broadcasts
  the settings-changed event a form save would.
- Scope is the project the chat is opened on. Absent means global.
- Do not import `@earendil-works/pi-*` here. Talk to `pi/transport.ts`.

## Testing Instructions

```bash
npm test
npx vitest run -t "smith"
npx vitest run apps/desktop/tests/main/smith/smith-chat-session.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-entity-tools.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-readiness-tools.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-system-prompt.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-proposals.test.ts
npx vitest run apps/desktop/tests/main/smith/smith-service.test.ts
```

- Chat-session tests drive the production object over
  `apps/desktop/tests/helpers/scripted-transport.ts`. No network, no model.
- Readiness-tool tests use **real git temp repos** and a real
  `ReadinessSession` with scripted io. Do not mock git.
- Entity-tool tests call `execute` the way the runtime does and assert that
  validation runs before any card is raised.
- Electron UI smoke for the chat screen, bubble, and inline card is
  `apps/desktop/tests/e2e/smith.spec.ts` (not part of `npm run check`).

## Invariants and Landmines

- **Projects are read-only over the tool surface, and projected.** `smith_list`
  answers `{ id, name, path }` only — never a full `ProjectDef`. Every other
  op on `kind: 'project'` errors. Neither the schema nor `execute` is the
  only gate.
- **One pending proposal at a time.** A second concurrent write rejects with
  `proposal_pending`. A failed save leaves the proposal pending (`answer()`
  returns false) so the card can show the error instead of silently dismissing.
  `cancelAll()` on shutdown unblocks a waiting tool call.
- **Rejection carries no note.** The next chat message is the revision
  guidance. `note` survives on the answer type only for the shutdown path.
- **Unknown tools fail closed.** The session policy allows registered custom
  tools by name and denies everything else.
- **Writes inside the checkout are allowed.** This is a deliberate departure
  from run policy: the operator is present and git is the undo. A write
  _outside_ the checkout is still denied.
- **Tracer writes no Smith rows.** Persistence is the transport's session file
  plus `chat-state.json` under the project's `pi/smith/` dir.
- **`~/.pi` is never touched.** Callers pin `stateDir` under the support dir.
- **Readiness remediation stays on `foundry-ready/<id>`.** Direct-checkout
  edits would not produce a reviewable PR, would not put the marker on the
  base ref, and would not survive "New chat".
- **`FOUNDRY_E2E_SMITH_PROPOSAL`** is a JSON `ProposalInput` the service
  enqueues at construction so the Electron UI smoke can render a card without
  a model. Production launches leave it unset.

## Code Style

- Keep the `SmithServiceDeps` seam narrow: the service takes callbacks, not
  `AppContext`. New capabilities arrive as another injected function, not an
  import reaching up.
- Tool modules are factories so they can close over stores/queue without this
  directory importing `AppContext`.
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
npm run package   # build + icons + electron-builder --mac --arm64
```

There is no second main-process entry and no `asarUnpack` for a helper
binary. Smith is in-process on the bundled pi runtime.

## Routing

Smith spans the chat session, the IPC seam, and the two renderer views.
Change them together.

| Location                                            | Responsibility                                             |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `src/main/ipc/smith.ts`                             | Chat invokes + proposal answer; `saveProposal` store write |
| `src/main/pi/transport.ts`                          | Vendor-neutral session seam the chat drives                |
| `src/main/readiness/`                               | Evaluate / marker / remediator the readiness tools wrap    |
| `src/renderer/screens/SmithScreen.tsx`              | Dedicated chat screen                                      |
| `src/renderer/components/smith/SmithBubble.*`       | Fin-style launcher + popover on every screen               |
| `src/renderer/components/smith/SmithProposalCard.*` | Inline approval card — where a write is allowed or refused |

## Additional Notes

- Two sources of truth for the entity schemas is a known, accepted cost: the
  harness prose, and the stores' `validate()`. The store is the enforcement,
  and a validation failure returns to the agent as JSON precise enough to
  correct itself, so the harness only has to be roughly right. Keep it
  roughly right anyway.
- Security posture: the operator is present, entity writes gate on Approve,
  and a write outside the checkout is denied. There is no socket and no
  external caller.
