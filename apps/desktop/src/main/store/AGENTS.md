# AGENTS.md — src/main/store

JSON-backed config. Builtins are seeds — a user's edited copy lives in their
own store and must never be clobbered by a change to `builtin-agents.ts` /
`builtin-pipelines.ts`. Changing a builtin only affects fresh installs and
`reset()`.

`validate()` on roster/pipelines returns `ValidationIssue[]` shown live in the
designer; `pipelines.ts:dryRun()` renders exact prompts without spending.
New fields need a migration that preserves existing user files. Keep
`json-store.ts` generic — domain logic belongs in the per-domain files.
