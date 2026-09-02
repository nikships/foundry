# AGENTS.md — src/main/store

Configuration is JSON, not opaque database state. Domain stores own validation and hydration; `JsonStore<T>` owns cached reads and atomic writes.

## Invariants

- **Normalize on read.** Add defaults in the domain migration so older or hand-edited files still load.
- **Write atomically.** Use a temporary sibling followed by rename.
- **Builtins are seeds.** Fresh installs and explicit reset receive current builtins; user edits and forks are never overwritten by a builtin update.
- **Invalidate on external refresh.** Drop the cache so the next read rehydrates from disk.
- **Credentials are not settings.** Provider keys belong to pi’s credential store; subscription tokens belong to the Bridge auth directory.

Keep generic store plumbing separate from domain rules. Export pure domain helpers when useful for tests.

When adding a field or builtin, test a file missing that field and verify user edits survive reseeding.

## Validation

```bash
npx vitest run -t "builtin|roster|pipeline|settings|envelope|local-store"
npx vitest run apps/desktop/tests/main/store/builtins.test.ts
```
