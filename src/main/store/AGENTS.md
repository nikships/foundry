# AGENTS.md — src/main/store

Configuration is JSON, not opaque database state. `JsonStore<T>` caches reads and writes via temp-file + rename (atomic), running its normalize-on-read hook so a hand-edited or incomplete file still loads. Keep writes atomic and invalidate the cache when an external refresh is required.

## Project Overview

- `json-store.ts` — generic cached JSON store (atomic write, normalize-on-read).
- `builtin-agents.ts` / `builtin-pipelines.ts` — seeds for fresh installs / `reset()`. Builtins are seeds, not authoritative overlays.
- `roster.ts` / `pipelines.ts` / `settings.ts` / `projects.ts` / `envelopes.ts` — domain stores owning validation + hydration for their domain.
- User-edited copies of builtins must never be clobbered when `builtin-*` changes; a missing shipped builtin is restored and forks/user copies are marked `non-builtin`.

## Setup Commands

```bash
npm ci
npm run dev    # stores hydrate from ~/Library/Application Support/foundry/
```

No store-specific setup. Projects are sharded per directory; deleting the support folder resets to builtins.

## Development Workflow

- Add fields by updating the domain Zod/type, handling defaults in the domain `migrate()` so a file missing the new field still loads. Never require a manual reset for a new optional field.
- Keep domain validation and hydration inside the per-domain store — not in callers.
- `validate()` returns live `ValidationIssue[]` for the UI; `pipelines.ts:dryRun()` renders prompts without spending a run.
- Builtin edits affect fresh installs and `reset()` only. When adding/restoring builtins, re-seed missing shipped IDs without overwriting user forks (compare `roster.ts` / `pipelines.ts`).

## Testing Instructions

```bash
npm test
npx vitest run -t "builtin|roster|pipeline|settings|envelope|local-store"
npx vitest run tests/builtins.test.ts
npx vitest run tests/roster-validate.test.ts
```

- Store tests use temp directories; assert missing-field defaults and that user edits survive builtin updates.
- When adding a builtin, add a test covering "file without the new field" and "missing builtin restoration."

## Invariants

- **Normalize on read.** New fields must load against a file that does not have them yet — defaults go in `migrate()`, not a breaking schema bump.
- **Atomic writes.** Temp sibling + `rename` so a crash doesn't corrupt JSON.
- **Builtins are seeds.** User-edited copies are never overwritten by a builtin bump; fresh installs and explicit `reset()` pick up the newest seeds.
- **Cache invalidation** on external refresh (file watcher / manual re-read) must drop the in-memory cache so the next read re-hydrates from disk.

## Code Style

- Domain stores export pure helpers where possible (testable without `AppContext`).
- Keep `JsonStore` generic plumbing separate from domain rules (validation, roster/pipeline rendering, builtin seeding).
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
```

Store code bundles into `out/main/main.js`; no separate build.

## Additional Notes

- `settings.ts` owns transport knobs (`compactionThreshold`, `rewindAfterCorrections`, `bridgePort`) surfaced in Settings → Limits/Transport. There is no transport choice: agent phases run in-process on pi (see `src/main/pi/AGENTS.md`).
- **No credential is a setting.** Provider API keys go to pi's credential store through `bridge.setApiKey`, and subscription tokens live in the Bridge's auth directory. `migrate()` copies only declared settings keys, so a hand-edited extra field never enters memory and never fails the next save.
