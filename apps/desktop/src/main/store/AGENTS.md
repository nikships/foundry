# src/main/store

Configuration is JSON, not opaque database state. `JsonStore` caches reads and
writes a temporary sibling file followed by rename, so keep writes atomic and
invalidate when an external refresh is required. Its migration runs on read;
new fields must preserve existing user files.

Builtins are seeds, not authoritative overlays. User-edited copies must never
be clobbered when `builtin-agents.ts` or `builtin-pipelines.ts` changes; a
builtin change affects fresh installs and `reset()`. Roster/pipeline migration
restores missing shipped builtins and marks forks/user copies non-builtin.

Keep domain validation and migration in the per-domain stores. `validate()`
returns live `ValidationIssue[]`; `pipelines.ts:dryRun()` renders prompts
without spending a run.
